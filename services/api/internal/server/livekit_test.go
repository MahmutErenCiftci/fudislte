package server_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const liveKitSecret = "test-livekit-secret-0123456789abcdef"

// fakeLiveKit stands in for LiveKit's server API: it serves the participants a test sets
// and records the moderation calls it receives.
type fakeLiveKit struct {
	url          string
	mu           sync.Mutex
	participants map[string][]map[string]any
	calls        []string
}

func newFakeLiveKit(t *testing.T) *fakeLiveKit {
	f := &fakeLiveKit{participants: map[string][]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		f.mu.Lock()
		defer f.mu.Unlock()
		room, _ := in["room"].(string)
		switch method {
		case "ListRooms":
			rooms := []map[string]string{}
			for name := range f.participants {
				rooms = append(rooms, map[string]string{"name": name})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"rooms": rooms})
		case "ListParticipants":
			_ = json.NewEncoder(w).Encode(map[string]any{"participants": f.participants[room]})
		case "RemoveParticipant":
			f.calls = append(f.calls, "remove "+room+" "+in["identity"].(string))
			_, _ = w.Write([]byte(`{}`))
		case "MutePublishedTrack":
			f.calls = append(f.calls, "mute "+room+" "+in["identity"].(string)+" "+in["track_sid"].(string))
			_, _ = w.Write([]byte(`{}`))
		default:
			http.Error(w, "unknown method", http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	f.url = srv.URL
	return f
}

func (f *fakeLiveKit) connect(room, userID, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.participants[room] = append(f.participants[room], map[string]any{
		"identity": userID, "name": name,
		"tracks": []map[string]any{{"sid": "TR_" + userID[:8], "type": "AUDIO", "source": "MICROPHONE", "muted": false}},
	})
}

func (f *fakeLiveKit) resetCalls() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

// called reports whether a call starting with prefix was recorded.
func (f *fakeLiveKit) called(prefix string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.ContainsFunc(f.calls, func(c string) bool { return strings.HasPrefix(c, prefix) })
}

// waitCall waits for a recorded call starting with prefix.
func (f *fakeLiveKit) waitCall(t *testing.T, prefix string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		for _, c := range f.calls {
			if strings.HasPrefix(c, prefix) {
				f.mu.Unlock()
				return
			}
		}
		f.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	t.Fatalf("no LiveKit call %q; calls: %v", prefix, f.calls)
}

// liveKitClaims decodes a token's payload; the media package tests its signature.
func liveKitClaims(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

// webhook posts a LiveKit webhook signed the way LiveKit signs them.
func (ts *testServer) webhook(event string) *http.Response {
	ts.t.Helper()
	sum := sha256.Sum256([]byte(event))
	enc := base64.RawURLEncoding
	payload, _ := json.Marshal(map[string]any{
		"iss": "devkey", "exp": time.Now().Add(time.Minute).Unix(), "sha256": base64.StdEncoding.EncodeToString(sum[:]),
	})
	unsigned := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(liveKitSecret))
	mac.Write([]byte(unsigned))
	req, _ := http.NewRequest(http.MethodPost, ts.url+"/api/v1/media/webhook", strings.NewReader(event))
	req.Header.Set("Content-Type", "application/webhook+json")
	req.Header.Set("Authorization", unsigned+"."+enc.EncodeToString(mac.Sum(nil)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		ts.t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp
}

func TestRoomVoice(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	other, otherID := ts.join(owner, orgID, "other@example.com", "developer")
	guest, _ := ts.join(owner, orgID, "guest@example.com", "guest")
	base := "/api/v1/orgs/" + orgID + "/rooms/"
	rm := lead.createRoom(orgID, map[string]any{"name": "Sesli Oda", "access": "protected", "password": "ses şifresi 1", "admissionMinutes": 60})
	lkRoom := "fudislte-" + rm.ID

	// Only admitted people get a token; it expires with their admission.
	expectError(t, emp.do(http.MethodPost, base+rm.ID+"/voice", nil), http.StatusForbidden, "not_admitted")
	expectError(t, guest.do(http.MethodPost, base+rm.ID+"/voice", nil), http.StatusNotFound, "not_found")
	in := emp.entered(orgID, rm.ID, "ses şifresi 1")
	var ticket struct {
		Voice struct {
			URL       string    `json:"url"`
			Token     string    `json:"token"`
			ExpiresAt time.Time `json:"expiresAt"`
		} `json:"voice"`
	}
	emp.must(http.StatusOK, http.MethodPost, base+rm.ID+"/voice", nil).decode(t, &ticket)
	claims := liveKitClaims(t, ticket.Voice.Token)
	video := claims["video"].(map[string]any)
	if ticket.Voice.URL != "ws://livekit.test" || claims["sub"] != empID || claims["name"] != "User employee" ||
		video["room"] != lkRoom || video["canPublish"] != true || ticket.Voice.ExpiresAt.After(in.AdmissionExpiresAt.Add(time.Second)) {
		t.Fatalf("ticket = %+v, claims = %v", ticket.Voice, claims)
	}

	// Who is in voice; managers mute and remove.
	ts.lk.connect(lkRoom, empID, "User employee")
	var state struct {
		Enabled      bool `json:"enabled"`
		Participants []struct {
			UserID string `json:"userId"`
			Muted  bool   `json:"muted"`
		} `json:"participants"`
	}
	emp.must(http.StatusOK, http.MethodGet, base+rm.ID+"/voice", nil).decode(t, &state)
	if !state.Enabled || len(state.Participants) != 1 || state.Participants[0].UserID != empID || state.Participants[0].Muted {
		t.Fatalf("voice state = %+v", state)
	}
	expectError(t, other.do(http.MethodPost, base+rm.ID+"/voice/"+empID+"/mute", nil), http.StatusForbidden, "forbidden")
	lead.must(http.StatusNoContent, http.MethodPost, base+rm.ID+"/voice/"+empID+"/mute", nil)
	ts.lk.waitCall(t, "mute "+lkRoom+" "+empID+" TR_")
	lead.must(http.StatusNoContent, http.MethodDelete, base+rm.ID+"/voice/"+empID, nil)
	ts.lk.waitCall(t, "remove "+lkRoom+" "+empID)

	// Someone who reaches LiveKit without admission is removed when LiveKit reports it.
	empEvents := emp.events()
	ts.lk.connect(lkRoom, otherID, "User developer")
	resp := ts.webhook(`{"event":"participant_joined","room":{"name":"` + lkRoom + `"},"participant":{"identity":"` + otherID + `","name":"User developer"}}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("webhook status %d", resp.StatusCode)
	}
	ts.lk.waitCall(t, "remove "+lkRoom+" "+otherID)
	empEvents.waitFor("voice.updated", roomEvent(rm.ID))
	req, _ := http.NewRequest(http.MethodPost, ts.url+"/api/v1/media/webhook", strings.NewReader(`{"event":"room_finished"}`))
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unsigned webhook accepted: %v %v", r, err)
	}

	// Ending the admission disconnects voice at once.
	ts.lk.resetCalls()
	lead.must(http.StatusOK, http.MethodPut, base+rm.ID+"/security", map[string]any{"access": "protected", "password": "yeni ses şifresi"})
	ts.lk.waitCall(t, "remove "+lkRoom+" "+empID)
}
