package chat

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNormalizeChannelName(t *testing.T) {
	ok := map[string]string{
		"Müşteri Destek":        "müşteri-destek",
		"#Backend":              "backend",
		"İnsan Kaynakları":      "insan-kaynakları",
		"  a  --  b. c  ":       "a-b-c",
		"ürün_2":                "ürün_2",
		"API":                   "api",
		strings.Repeat("ş", 40): strings.Repeat("ş", 40),
	}
	for in, want := range ok {
		if got, msg := NormalizeChannelName(in); got != want || msg != "" {
			t.Errorf("NormalizeChannelName(%q) = %q, %q; want %q", in, got, msg, want)
		}
	}
	for _, in := range []string{"", " - ", "#", "hey!", "a/b", strings.Repeat("a", 41)} {
		if got, msg := NormalizeChannelName(in); msg == "" {
			t.Errorf("NormalizeChannelName(%q) = %q, want an error", in, got)
		}
	}
}

func TestPreviewKeepsMentionsWhole(t *testing.T) {
	body := strings.Repeat("a", 190) + "<@0190a8b4-0000-7000-8000-000000000000> devamı"
	if got := preview(body); got != strings.Repeat("a", 190)+"…" {
		t.Errorf("preview = %q", got)
	}
	if got := preview("kısa <@0190a8b4-0000-7000-8000-000000000000>"); !strings.HasSuffix(got, ">") {
		t.Errorf("short bodies stay unchanged: %q", got)
	}
}

func TestNormalizeBody(t *testing.T) {
	if got, _ := normalizeBody("  \r\nsatır 1\r\n\tsatır 2\x00\x07 \n "); got != "satır 1\n\tsatır 2" {
		t.Errorf("normalizeBody = %q", got)
	}
	if _, msg := normalizeBody(" \n "); msg == "" {
		t.Error("blank message accepted")
	}
}

func TestParseVoiceRoom(t *testing.T) {
	id := uuid.MustParse("0190a8b4-0000-7000-8000-000000000000")
	for name, want := range map[string]voiceTarget{
		"fudislte-" + id.String():         {id: id},
		"fudislte-meeting-" + id.String(): {meeting: true, id: id},
	} {
		if got, ok := parseVoiceRoom(name); !ok || got != want || got.room() != name {
			t.Errorf("parseVoiceRoom(%q) = %+v, %v", name, got, ok)
		}
	}
	for _, name := range []string{"", "fudislte-", "fudislte-meeting-", "fudislte-meeting-x", "other-" + id.String(),
		"fudislte-urn:uuid:" + id.String(), "fudislte-meeting-{" + id.String() + "}"} {
		if got, ok := parseVoiceRoom(name); ok {
			t.Errorf("parseVoiceRoom(%q) = %+v, want no match", name, got)
		}
	}
}

func TestMeetingJoinWindow(t *testing.T) {
	start := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	mt := Meeting{StartsAt: start, DurationMinutes: 45}
	mt.settle(uuid.Nil)
	for at, want := range map[time.Time]error{
		start.Add(-16 * time.Minute):                errMeetingNotStarted,
		start.Add(-15 * time.Minute):                nil,
		start.Add(45 * time.Minute):                 nil,
		start.Add(45*time.Minute + 2*time.Hour - 1): nil,
		start.Add(45*time.Minute + 2*time.Hour):     errMeetingEnded,
	} {
		if got := mt.joinable(at); got != want {
			t.Errorf("joinable(%s) = %v, want %v", at, got, want)
		}
	}
	canceled := start
	mt.CanceledAt = &canceled
	if got := mt.joinable(start); got != errMeetingCanceled {
		t.Errorf("canceled meeting: %v", got)
	}
}

func TestNormalizeMeetingFields(t *testing.T) {
	if got, msg := normalizeMeetingTitle("  Sprint \t Planlama  "); got != "Sprint Planlama" || msg != "" {
		t.Errorf("title = %q, %q", got, msg)
	}
	for _, in := range []string{"", "   ", strings.Repeat("ş", 121)} {
		if _, msg := normalizeMeetingTitle(in); msg == "" {
			t.Errorf("title %q accepted", in)
		}
	}
	if got, msg := normalizeAgenda(" \r\n1. Hedefler\r\n\t2. Riskler\x07 \n"); got != "1. Hedefler\n\t2. Riskler" || msg != "" {
		t.Errorf("agenda = %q, %q", got, msg)
	}
	if _, msg := normalizeAgenda(strings.Repeat("ğ", 2001)); msg == "" {
		t.Error("an agenda of 2001 characters was accepted")
	}
}
