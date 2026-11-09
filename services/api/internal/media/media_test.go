package media

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fudislte/api/internal/config"
)

const secret = "0123456789abcdef0123456789abcdef"

func testService(apiURL string) *Service {
	return New(config.Media{URL: "ws://localhost:7880", APIURL: apiURL, APIKey: "devkey", APISecret: secret})
}

func TestTokenCarriesTheGrant(t *testing.T) {
	s := testService("http://unused")
	exp := time.Now().Add(time.Hour)
	token, err := s.Token("user-1", "Dana", Grant{Room: "fudislte-r1", CanPublish: true, Sources: []string{"microphone"}}, exp)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := s.verify(token)
	if err != nil {
		t.Fatal(err)
	}
	video := claims["video"].(map[string]any)
	if claims["sub"] != "user-1" || claims["name"] != "Dana" || claims["iss"] != "devkey" ||
		video["room"] != "fudislte-r1" || video["roomJoin"] != true || video["canPublish"] != true ||
		int64(claims["exp"].(float64)) != exp.Unix() {
		t.Fatalf("claims = %v", claims)
	}
	if srcs := video["canPublishSources"].([]any); len(srcs) != 1 || srcs[0] != "microphone" {
		t.Fatalf("sources = %v", srcs)
	}

	// A token signed with another secret, or tampered with, is refused.
	other := New(config.Media{URL: "ws://x", APIURL: "http://x", APIKey: "devkey", APISecret: strings.Repeat("z", 32)})
	if _, err := other.verify(token); err == nil {
		t.Fatal("token verified with the wrong secret")
	}
	parts := strings.Split(token, ".")
	forged := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"devkey","exp":9999999999}`)) + "." + parts[2]
	if _, err := s.verify(forged); err == nil {
		t.Fatal("tampered token verified")
	}
	if _, err := New(config.Media{}).Token("u", "n", Grant{Room: "r"}, exp); err != ErrDisabled {
		t.Fatalf("disabled media err = %v", err)
	}
}

func TestServerAPICalls(t *testing.T) {
	var calls []string
	var s *Service
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := s.verify(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if err != nil || claims["video"].(map[string]any)["roomAdmin"] != true {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(r.Body)
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		calls = append(calls, method+" "+string(body))
		switch method {
		case "ListParticipants":
			_, _ = w.Write([]byte(`{"participants":[{"sid":"PA_1","identity":"user-1","name":"Dana","tracks":[{"sid":"TR_1","type":"AUDIO","source":"MICROPHONE","muted":false}]}]}`))
		case "RemoveParticipant":
			http.Error(w, `{"code":"not_found","msg":"participant not found"}`, http.StatusNotFound)
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()
	s = testService(srv.URL)
	ctx := t.Context()

	people, err := s.Participants(ctx, "fudislte-r1")
	if err != nil || len(people) != 1 || people[0].Identity != "user-1" || people[0].Tracks[0].SID != "TR_1" {
		t.Fatalf("participants = %+v, %v", people, err)
	}
	// Removing someone who is not connected is fine.
	if err := s.RemoveParticipant(ctx, "fudislte-r1", "user-2"); err != nil {
		t.Fatal(err)
	}
	if err := s.MuteTrack(ctx, "fudislte-r1", "user-1", "TR_1"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 3 || !strings.Contains(calls[1], `"identity":"user-2"`) || !strings.Contains(calls[2], `"track_sid":"TR_1"`) {
		t.Fatalf("calls = %v", calls)
	}
}

func TestParseWebhook(t *testing.T) {
	s := testService("http://unused")
	body := []byte(`{"event":"participant_joined","room":{"name":"fudislte-r1"},"participant":{"identity":"user-1","name":"Dana"}}`)
	sum := sha256.Sum256(body)
	signed := func(b64 string) *http.Request {
		token, err := s.sign(map[string]any{"iss": "devkey", "exp": time.Now().Add(time.Minute).Unix(), "sha256": b64})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
		r.Header.Set("Authorization", token)
		return r
	}
	ev, err := s.ParseWebhook(signed(base64.StdEncoding.EncodeToString(sum[:])))
	if err != nil || ev.Event != "participant_joined" || ev.Room.Name != "fudislte-r1" || ev.Participant.Identity != "user-1" {
		t.Fatalf("event = %+v, %v", ev, err)
	}
	if _, err := s.ParseWebhook(signed("not-the-body-hash")); err == nil {
		t.Fatal("webhook with a wrong body hash accepted")
	}
	r := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	if _, err := s.ParseWebhook(r); err == nil {
		t.Fatal("unsigned webhook accepted")
	}
}
