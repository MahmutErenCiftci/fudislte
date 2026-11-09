// Package media talks to the self-hosted LiveKit server that carries voice and video
// (ADR-0011): it signs access tokens, calls LiveKit's server API to remove or mute
// participants, and verifies LiveKit's webhooks. Only the standard library is used;
// LiveKit tokens are HS256 JWTs and its server API is Twirp over JSON.
package media

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"fudislte/api/internal/config"
)

// ErrDisabled is returned when no LiveKit server is configured.
var ErrDisabled = errors.New("media: no LiveKit server configured")

type Service struct {
	cfg  config.Media
	http *http.Client
}

func New(cfg config.Media) *Service {
	return &Service{cfg: cfg, http: &http.Client{Timeout: 5 * time.Second}}
}

func (s *Service) Enabled() bool { return s != nil && s.cfg.Enabled() }

// URL is the address clients connect to.
func (s *Service) URL() string { return s.cfg.URL }

// RoomName is the LiveKit room for a FUDISLTE room.
func RoomName(id fmt.Stringer) string { return "fudislte-" + id.String() }

// MeetingRoomName is the LiveKit room for a meeting.
func MeetingRoomName(id fmt.Stringer) string { return "fudislte-meeting-" + id.String() }

// Grant is what a participant may do in one LiveKit room.
type Grant struct {
	Room       string
	CanPublish bool
	// Sources limits what may be published: microphone, camera, screen_share,
	// screen_share_audio.
	Sources []string
}

// Token signs an access token for identity (a user ID) to join grant.Room until expires.
func (s *Service) Token(identity, name string, grant Grant, expires time.Time) (string, error) {
	if !s.Enabled() {
		return "", ErrDisabled
	}
	now := time.Now()
	video := map[string]any{
		"room":           grant.Room,
		"roomJoin":       true,
		"canSubscribe":   true,
		"canPublish":     grant.CanPublish,
		"canPublishData": true,
	}
	if grant.CanPublish && len(grant.Sources) > 0 {
		video["canPublishSources"] = grant.Sources
	}
	return s.sign(map[string]any{
		"iss":   s.cfg.APIKey,
		"sub":   identity,
		"name":  name,
		"nbf":   now.Add(-10 * time.Second).Unix(),
		"exp":   expires.Unix(),
		"video": video,
	})
}

func (s *Service) sign(claims map[string]any) (string, error) {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := header + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(s.cfg.APISecret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + enc.EncodeToString(mac.Sum(nil)), nil
}

// verify checks an HS256 JWT signed with the API secret and returns its claims.
func (s *Service) verify(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("media: malformed token")
	}
	enc := base64.RawURLEncoding
	header, err := enc.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("media: malformed token")
	}
	var h struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(header, &h) != nil || h.Alg != "HS256" {
		return nil, errors.New("media: unexpected token algorithm")
	}
	sig, err := enc.DecodeString(parts[2])
	if err != nil {
		return nil, errors.New("media: malformed token")
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.APISecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, errors.New("media: bad token signature")
	}
	payload, err := enc.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("media: malformed token")
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, errors.New("media: malformed token")
	}
	now := float64(time.Now().Unix())
	if exp, ok := claims["exp"].(float64); !ok || exp < now-60 {
		return nil, errors.New("media: token expired")
	}
	if nbf, ok := claims["nbf"].(float64); ok && nbf > now+60 {
		return nil, errors.New("media: token not yet valid")
	}
	if claims["iss"] != s.cfg.APIKey {
		return nil, errors.New("media: unknown token issuer")
	}
	return claims, nil
}

// call invokes a LiveKit RoomService method with a short-lived admin token for room, or
// a room-listing token when room is empty.
func (s *Service) call(ctx context.Context, room, method string, in, out any) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	video := map[string]any{"room": room, "roomAdmin": true}
	if room == "" {
		video = map[string]any{"roomList": true}
	}
	token, err := s.sign(map[string]any{
		"iss":   s.cfg.APIKey,
		"nbf":   time.Now().Add(-10 * time.Second).Unix(),
		"exp":   time.Now().Add(time.Minute).Unix(),
		"video": video,
	})
	if err != nil {
		return err
	}
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.APIURL+"/twirp/livekit.RoomService/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("media: %s: %w", method, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("media: %s: status %d: %s", method, resp.StatusCode, bytes.TrimSpace(data))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

var errNotFound = errors.New("media: not found")

// RemoveParticipant disconnects identity from room. Someone not connected is not an error.
func (s *Service) RemoveParticipant(ctx context.Context, room, identity string) error {
	err := s.call(ctx, room, "RemoveParticipant", map[string]string{"room": room, "identity": identity}, nil)
	if errors.Is(err, errNotFound) {
		return nil
	}
	return err
}

// MuteTrack mutes one published track of identity (moderation).
func (s *Service) MuteTrack(ctx context.Context, room, identity, trackSID string) error {
	return s.call(ctx, room, "MutePublishedTrack", map[string]any{
		"room": room, "identity": identity, "track_sid": trackSID, "muted": true,
	}, nil)
}

// Track is a published track as LiveKit reports it.
type Track struct {
	SID    string `json:"sid"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Muted  bool   `json:"muted"`
}

// Participant is someone connected to a LiveKit room.
type Participant struct {
	Identity string  `json:"identity"`
	Name     string  `json:"name"`
	Tracks   []Track `json:"tracks"`
}

// Participants lists who is connected to room; an unknown room has nobody.
func (s *Service) Participants(ctx context.Context, room string) ([]Participant, error) {
	var out struct {
		Participants []Participant `json:"participants"`
	}
	err := s.call(ctx, room, "ListParticipants", map[string]string{"room": room}, &out)
	if errors.Is(err, errNotFound) {
		return nil, nil
	}
	return out.Participants, err
}

// Rooms lists the names of the LiveKit rooms that are open now.
func (s *Service) Rooms(ctx context.Context) ([]string, error) {
	var out struct {
		Rooms []struct {
			Name string `json:"name"`
		} `json:"rooms"`
	}
	if err := s.call(ctx, "", "ListRooms", map[string]any{}, &out); err != nil {
		return nil, err
	}
	names := make([]string, len(out.Rooms))
	for i, r := range out.Rooms {
		names[i] = r.Name
	}
	return names, nil
}

// Event is a LiveKit webhook notification.
type Event struct {
	Event string `json:"event"`
	Room  *struct {
		Name string `json:"name"`
	} `json:"room"`
	Participant *Participant `json:"participant"`
}

// ParseWebhook verifies a webhook request — a JWT in the Authorization header, signed
// with the API secret, carrying the SHA-256 of the body — and returns the event.
func (s *Service) ParseWebhook(r *http.Request) (*Event, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	claims, err := s.verify(token)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(body)
	want, _ := claims["sha256"].(string)
	if want != base64.StdEncoding.EncodeToString(sum[:]) {
		return nil, errors.New("media: webhook body does not match its signature")
	}
	var ev Event
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, err
	}
	return &ev, nil
}
