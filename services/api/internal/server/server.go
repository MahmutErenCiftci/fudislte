// Package server wires modules into the HTTP router.
package server

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/boards"
	"fudislte/api/internal/chat"
	"fudislte/api/internal/config"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/login"
	"fudislte/api/internal/mail"
	"fudislte/api/internal/media"
	"fudislte/api/internal/org"
	"fudislte/api/internal/presence"
	"fudislte/api/internal/projects"
	"fudislte/api/internal/realtime"
	"fudislte/api/internal/registration"
	"fudislte/api/internal/setup"
	"fudislte/api/internal/storage"
)

type Deps struct {
	DB      *pgxpool.Pool
	Config  config.Config
	Version string
	Outbox  *mail.Outbox
	// Hub carries live events; the caller closes it on shutdown. A new hub is created
	// when nil.
	Hub *realtime.Hub
	// LookupTXT resolves DNS TXT records for domain verification; nil uses the system
	// resolver.
	LookupTXT org.LookupTXT
	// SweepEvery is how often expired room admissions end and calls are checked for
	// people who may no longer be in them; zero means every 30 seconds.
	SweepEvery time.Duration
}

func New(ctx context.Context, d Deps) (http.Handler, error) {
	hub := d.Hub
	if hub == nil {
		hub = realtime.NewHub()
	}
	authSvc := auth.NewService(d.DB, auth.Options{
		CookieSecure:    d.Config.CookieSecure,
		SessionIdleTTL:  d.Config.SessionIdleTTL,
		SessionsRevoked: hub.CloseSessions,
	})
	orgSvc := org.NewService(d.DB, authSvc, d.Outbox, d.Config.PublicURL, d.LookupTXT)
	files, err := storage.NewDisk(d.Config.DataDir)
	if err != nil {
		return nil, err
	}
	chatSvc := chat.NewService(d.DB, hub, files, d.Config.MaxUploadBytes)
	chatSvc.SetMedia(media.New(d.Config.Media))
	chatSvc.SetMail(d.Outbox, d.Config.PublicURL)
	sweepEvery := d.SweepEvery
	if sweepEvery <= 0 {
		sweepEvery = 30 * time.Second
	}
	go chat.Janitor(ctx, d.DB, files, time.Hour)
	go chatSvc.ExpireAdmissions(ctx, sweepEvery)
	presenceSvc := presence.NewService(d.DB, hub)
	projectsSvc := projects.NewService(d.DB, hub)
	boardsSvc := boards.NewService(d.DB, hub)
	go boardsSvc.Sweep(ctx, 5*time.Second)
	loginSvc := login.NewService(d.DB, authSvc, d.Outbox, d.Config.PublicURL)
	registrationSvc := registration.New(d.DB, d.Config.RegistryURL, d.Version)
	go registrationSvc.Run(ctx)
	setupSvc, err := setup.New(ctx, d.DB, authSvc, d.Outbox, setup.Options{
		Version: d.Version, PublicURL: d.Config.PublicURL, Token: d.Config.SetupToken, Registration: registrationSvc,
	})
	if err != nil {
		return nil, err
	}

	h := httpx.Handle
	member := orgSvc.RequireMember
	perm := org.RequirePermission

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(i18n.Middleware(d.Config.DefaultLocale))
	r.Use(httpx.NewIPResolver(d.Config.TrustedProxies).Middleware)
	r.Use(httpx.RequestLogger)
	r.Use(httpx.Recoverer)
	r.Use(httpx.SecurityHeaders)
	r.NotFound(h(func(w http.ResponseWriter, r *http.Request) error { return httpx.ErrNotFound }))
	r.MethodNotAllowed(h(func(w http.ResponseWriter, r *http.Request) error {
		return httpx.NewError(http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
	}))

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", h(func(w http.ResponseWriter, r *http.Request) error {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := d.DB.Ping(ctx); err != nil {
			httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "database unavailable"})
			return nil
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"})
		return nil
	}))

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(crossOriginProtection())
		r.Use(authSvc.Authenticate)

		r.Get("/meta", h(setupSvc.Meta))
		// LiveKit signs its webhooks with the API secret (ADR-0011).
		r.Post("/media/webhook", h(chatSvc.MediaWebhook))
		r.Post("/setup/code", h(setupSvc.RequestCode))
		r.Post("/setup", h(setupSvc.Complete))
		r.Post("/auth/code", h(loginSvc.RequestCode))
		r.Post("/auth/verify", h(loginSvc.VerifyCode))
		r.Post("/auth/logout", h(authSvc.Logout))
		r.Post("/auth/access-key", h(orgSvc.RedeemAccessKey))
		r.Get("/invitations/{token}", h(orgSvc.PreviewInvitation))
		r.Post("/invitations/{token}/code", h(orgSvc.RequestInvitationCode))
		r.Post("/invitations/{token}/accept", h(orgSvc.AcceptInvitation))

		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)

			r.Get("/me", h(orgSvc.Me))
			r.Patch("/me", h(authSvc.UpdateProfile))
			r.Get("/me/sessions", h(authSvc.ListSessions))
			r.Delete("/me/sessions", h(authSvc.RevokeOtherSessions))
			r.Delete("/me/sessions/{sessionID}", h(authSvc.RevokeSession))
			r.Get("/instance/session-policy", h(authSvc.GetSessionPolicy))
			r.Put("/instance/session-policy", h(authSvc.UpdateSessionPolicy))
			r.Get("/instance/registration", h(registrationSvc.Get))
			r.Put("/instance/registration", h(registrationSvc.Update))
			r.Get("/permissions", h(orgSvc.Permissions))
			r.Get("/events", h(hub.Stream))
			r.Post("/presence", h(hub.ReportActivity))
			r.Put("/me/status", h(presenceSvc.SetStatus))
			r.Delete("/me/status", h(presenceSvc.ClearStatus))
			r.Post("/orgs", h(orgSvc.CreateOrganizationHandler))

			r.Route("/orgs/{orgID}", func(r chi.Router) {
				r.Use(member)

				r.Get("/", h(orgSvc.GetOrganization))
				r.With(perm(org.PermOrgManage)).Patch("/", h(orgSvc.UpdateOrganization))

				r.With(perm(org.PermMembersView)).Get("/members", h(orgSvc.ListMembers))
				r.With(perm(org.PermMembersManage)).Patch("/members/{userID}", h(orgSvc.UpdateMember))
				r.With(perm(org.PermMembersManage)).Delete("/members/{userID}", h(orgSvc.RemoveMember))
				r.Post("/members/{userID}/disable", h(orgSvc.DisableMember))
				r.Post("/members/{userID}/enable", h(orgSvc.EnableMember))

				r.Get("/roles", h(orgSvc.ListRoles))
				r.With(perm(org.PermRolesManage)).Post("/roles", h(orgSvc.CreateRole))
				r.With(perm(org.PermRolesManage)).Patch("/roles/{roleID}", h(orgSvc.UpdateRole))
				r.With(perm(org.PermRolesManage)).Delete("/roles/{roleID}", h(orgSvc.DeleteRole))

				r.With(perm(org.PermMembersInvite)).Get("/invitations", h(orgSvc.ListInvitations))
				r.With(perm(org.PermMembersInvite)).Post("/invitations", h(orgSvc.CreateInvitation))
				r.With(perm(org.PermMembersInvite)).Delete("/invitations/{invitationID}", h(orgSvc.RevokeInvitation))
				r.With(perm(org.PermMembersManage)).Get("/access-keys", h(orgSvc.ListAccessKeys))
				r.With(perm(org.PermMembersManage)).Post("/access-keys", h(orgSvc.CreateAccessKey))
				r.With(perm(org.PermMembersManage)).Delete("/access-keys/{keyID}", h(orgSvc.RevokeAccessKey))

				r.With(perm(org.PermOrgManage)).Get("/domains", h(orgSvc.ListDomains))
				r.With(perm(org.PermOrgManage)).Post("/domains", h(orgSvc.AddDomain))
				r.With(perm(org.PermOrgManage)).Delete("/domains/{domain}", h(orgSvc.RemoveDomain))
				r.With(perm(org.PermOrgManage)).Post("/domains/{domain}/verify", h(orgSvc.VerifyDomain))

				r.With(perm(org.PermAuditView)).Get("/audit-events", h(orgSvc.ListAuditEvents))

				r.With(perm(org.PermMembersView)).Get("/presence", h(presenceSvc.ListPresence))
				r.Get("/search", h(chatSvc.Search))
				r.Get("/files/{fileID}", h(chatSvc.DownloadFile))
				r.Delete("/files/{fileID}", h(chatSvc.DeleteUpload))
				r.Get("/retention", h(chatSvc.GetRetention))
				r.With(perm(org.PermOrgManage)).Put("/retention", h(chatSvc.SetRetention))
				r.Get("/notifications", h(chatSvc.ListNotifications))
				r.Post("/notifications/read", h(chatSvc.ReadNotifications))
				r.Get("/conversations", h(chatSvc.ListConversations))
				r.Post("/conversations", h(chatSvc.OpenConversation))
				r.Get("/rooms", h(chatSvc.ListRooms))
				r.With(perm(org.PermRoomsCreate)).Post("/rooms", h(chatSvc.CreateRoom))
				r.Route("/rooms/{roomID}", func(r chi.Router) {
					r.Get("/", h(chatSvc.GetRoom))
					r.Patch("/", h(chatSvc.UpdateRoom))
					r.Delete("/", h(chatSvc.DeleteRoom))
					r.Put("/security", h(chatSvc.SetRoomSecurity))
					r.Get("/access", h(chatSvc.RoomAccess))
					r.Put("/access", h(chatSvc.SetRoomAccess))
					r.Post("/enter", h(chatSvc.EnterRoom))
					r.Post("/leave", h(chatSvc.LeaveRoom))
					r.Get("/members", h(chatSvc.RoomMembers))
					r.Delete("/members/{userID}", h(chatSvc.EndAdmission))
					r.Get("/voice", h(chatSvc.VoiceState))
					r.Post("/voice", h(chatSvc.JoinVoice))
					r.Post("/voice/{userID}/mute", h(chatSvc.MuteInVoice))
					r.Delete("/voice/{userID}", h(chatSvc.RemoveFromVoice))
				})
				r.Get("/meetings", h(chatSvc.ListMeetings))
				r.With(perm(org.PermMeetingsCreate)).Post("/meetings", h(chatSvc.CreateMeeting))
				r.Route("/meetings/{meetingID}", func(r chi.Router) {
					r.Get("/", h(chatSvc.GetMeeting))
					r.Patch("/", h(chatSvc.UpdateMeeting))
					r.Delete("/", h(chatSvc.CancelMeeting))
					r.Get("/voice", h(chatSvc.MeetingVoiceState))
					r.Post("/voice", h(chatSvc.JoinMeetingVoice))
					r.Post("/voice/{userID}/mute", h(chatSvc.MuteInMeeting))
					r.Delete("/voice/{userID}", h(chatSvc.RemoveFromMeeting))
				})
				r.Get("/channels", h(chatSvc.ListChannels))
				r.Get("/channels/browse", h(chatSvc.BrowseChannels))
				r.With(perm(org.PermChannelsCreate)).Post("/channels", h(chatSvc.CreateChannel))
				r.Route("/channels/{channelID}", func(r chi.Router) {
					r.Get("/", h(chatSvc.GetChannel))
					r.Patch("/", h(chatSvc.UpdateChannel))
					r.Post("/join", h(chatSvc.JoinChannel))
					r.Post("/leave", h(chatSvc.LeaveChannel))
					r.Post("/read", h(chatSvc.MarkRead))
					r.Post("/typing", h(chatSvc.Typing))
					r.Post("/archive", h(chatSvc.ArchiveChannel))
					r.Post("/unarchive", h(chatSvc.UnarchiveChannel))
					r.Get("/files", h(chatSvc.ListFiles))
					r.Post("/files", h(chatSvc.UploadFile))
					r.Get("/members", h(chatSvc.ListChannelMembers))
					r.Post("/members", h(chatSvc.AddChannelMembers))
					r.Delete("/members/{userID}", h(chatSvc.RemoveChannelMember))
					r.Get("/messages", h(chatSvc.ListMessages))
					r.Post("/messages", h(chatSvc.PostMessage))
					r.Patch("/messages/{messageID}", h(chatSvc.EditMessage))
					r.Delete("/messages/{messageID}", h(chatSvc.DeleteMessage))
					r.Get("/messages/{messageID}/replies", h(chatSvc.ListReplies))
					r.Post("/messages/{messageID}/reactions", h(chatSvc.AddReaction))
					r.Delete("/messages/{messageID}/reactions", h(chatSvc.RemoveReaction))
					r.Put("/messages/{messageID}/pin", h(chatSvc.PinMessage))
					r.Delete("/messages/{messageID}/pin", h(chatSvc.UnpinMessage))
					r.Get("/pins", h(chatSvc.ListPins))
					r.Get("/tasks", h(projectsSvc.ChannelTasks))
				})

				r.Get("/tasks", h(projectsSvc.ListMyTasks))
				r.Get("/projects", h(projectsSvc.ListProjects))
				r.With(perm(org.PermProjectsCreate)).Post("/projects", h(projectsSvc.CreateProject))
				r.Route("/projects/{projectID}", func(r chi.Router) {
					r.Get("/", h(projectsSvc.GetProject))
					r.Patch("/", h(projectsSvc.UpdateProject))
					r.Post("/archive", h(projectsSvc.ArchiveProject))
					r.Post("/unarchive", h(projectsSvc.UnarchiveProject))
					r.Get("/activity", h(projectsSvc.ProjectActivity))
					r.Post("/join", h(projectsSvc.JoinProject))
					r.Post("/members", h(projectsSvc.AddMembers))
					r.Patch("/members/{userID}", h(projectsSvc.UpdateMember))
					r.Delete("/members/{userID}", h(projectsSvc.RemoveMember))
					r.Post("/statuses", h(projectsSvc.CreateStatus))
					r.Put("/statuses/order", h(projectsSvc.ReorderStatuses))
					r.Patch("/statuses/{statusID}", h(projectsSvc.UpdateStatus))
					r.Delete("/statuses/{statusID}", h(projectsSvc.DeleteStatus))
					r.Post("/labels", h(projectsSvc.CreateLabel))
					r.Patch("/labels/{labelID}", h(projectsSvc.UpdateLabel))
					r.Delete("/labels/{labelID}", h(projectsSvc.DeleteLabel))
					r.Post("/sprints", h(projectsSvc.CreateSprint))
					r.Patch("/sprints/{sprintID}", h(projectsSvc.UpdateSprint))
					r.Delete("/sprints/{sprintID}", h(projectsSvc.DeleteSprint))
					r.Post("/sprints/{sprintID}/start", h(projectsSvc.StartSprint))
					r.Post("/sprints/{sprintID}/complete", h(projectsSvc.CompleteSprint))
					r.Get("/tasks", h(projectsSvc.ListTasks))
					r.Post("/tasks", h(projectsSvc.CreateTask))
					r.Route("/tasks/{taskID}", func(r chi.Router) {
						r.Get("/", h(projectsSvc.GetTask))
						r.Patch("/", h(projectsSvc.UpdateTask))
						r.Delete("/", h(projectsSvc.DeleteTask))
						r.Post("/checklist", h(projectsSvc.AddChecklistItem))
						r.Patch("/checklist/{itemID}", h(projectsSvc.UpdateChecklistItem))
						r.Delete("/checklist/{itemID}", h(projectsSvc.DeleteChecklistItem))
						r.Post("/comments", h(projectsSvc.AddComment))
						r.Patch("/comments/{commentID}", h(projectsSvc.EditComment))
						r.Delete("/comments/{commentID}", h(projectsSvc.DeleteComment))
						r.Post("/links", h(projectsSvc.AddLink))
						r.Delete("/links/{channelID}", h(projectsSvc.RemoveLink))
					})
				})

				// Workspace boards need boards.create; project boards follow the project.
				r.Get("/boards", h(boardsSvc.ListBoards))
				r.Post("/boards", h(boardsSvc.CreateBoard))
				r.Route("/boards/{boardID}", func(r chi.Router) {
					r.Get("/", h(boardsSvc.GetBoard))
					r.Patch("/", h(boardsSvc.UpdateBoard))
					r.Delete("/", h(boardsSvc.DeleteBoard))
					r.Patch("/elements", h(boardsSvc.SaveElements))
					r.Post("/presence", h(boardsSvc.Heartbeat))
					r.Delete("/presence", h(boardsSvc.Leave))
					r.Post("/cursor", h(boardsSvc.Cursor))
				})
			})
		})
	})
	return r, nil
}

// crossOriginProtection rejects cross-site state-changing requests using Fetch
// Metadata and Origin headers (CSRF defence for cookie-authenticated requests).
func crossOriginProtection() func(http.Handler) http.Handler {
	cop := http.NewCrossOriginProtection()
	cop.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, r, httpx.NewError(http.StatusForbidden, "cross_origin_rejected", "Cross-origin requests are not allowed."))
	}))
	return cop.Handler
}
