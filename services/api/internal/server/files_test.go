package server_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fudislte/api/internal/chat"
	"fudislte/api/internal/storage"
)

// A PNG signature is enough for content detection.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)

type attachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	Image       bool   `json:"image"`
}

func (c *client) upload(orgID, channelID, name string, data []byte) response {
	c.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		c.t.Fatal(err)
	}
	fw.Write(data)
	mw.Close()
	req, _ := http.NewRequest(http.MethodPost, c.base+"/api/v1/orgs/"+orgID+"/channels/"+channelID+"/files", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{status: resp.StatusCode, body: b}
}

func (c *client) uploaded(orgID, channelID, name string, data []byte) attachment {
	c.t.Helper()
	r := c.upload(orgID, channelID, name, data)
	if r.status != http.StatusCreated {
		c.t.Fatalf("upload %s: status %d: %s", name, r.status, r.body)
	}
	var out struct {
		Attachment attachment `json:"attachment"`
	}
	r.decode(c.t, &out)
	return out.Attachment
}

func (c *client) download(orgID, fileID, query string) *http.Response {
	c.t.Helper()
	resp, err := c.hc.Get(c.base + "/api/v1/orgs/" + orgID + "/files/" + fileID + query)
	if err != nil {
		c.t.Fatal(err)
	}
	c.t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestAttachments(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	general := owner.channels(orgID)[0].ID
	base := "/api/v1/orgs/" + orgID + "/channels/" + general

	img := emp.uploaded(orgID, general, "ekran görüntüsü.png", pngBytes)
	if !img.Image || img.ContentType != "image/png" || img.Name != "ekran görüntüsü.png" || img.Size != int64(len(pngBytes)) {
		t.Fatalf("uploaded = %+v", img)
	}
	// Unsent files belong to their uploader alone.
	if r := owner.download(orgID, img.ID, ""); r.StatusCode != http.StatusNotFound {
		t.Fatalf("owner downloading an unsent file: %d", r.StatusCode)
	}

	// The type comes from the bytes; HTML is never served as HTML.
	page := emp.uploaded(orgID, general, "rapor.png.html", []byte("<html><script>alert(1)</script></html>"))
	if page.ContentType != "text/html" || page.Image {
		t.Fatalf("html upload = %+v", page)
	}

	// Files alone are a message.
	var sent struct {
		Message struct {
			ID          string       `json:"id"`
			Attachments []attachment `json:"attachments"`
		} `json:"message"`
	}
	emp.must(http.StatusCreated, http.MethodPost, base+"/messages", map[string]any{"attachmentIds": []string{img.ID, page.ID}}).decode(t, &sent)
	if len(sent.Message.Attachments) != 2 || sent.Message.Attachments[0].ID != img.ID {
		t.Fatalf("sent = %+v", sent.Message)
	}
	if got := owner.richHistory(orgID, general); len(got) != 1 {
		t.Fatalf("history = %+v", got)
	}

	r := owner.download(orgID, img.ID, "")
	body, _ := io.ReadAll(r.Body)
	if r.StatusCode != http.StatusOK || r.Header.Get("Content-Type") != "image/png" || !bytes.Equal(body, pngBytes) ||
		!strings.HasPrefix(r.Header.Get("Content-Disposition"), "inline") || !strings.Contains(r.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("image download: %d %v", r.StatusCode, r.Header)
	}
	r = owner.download(orgID, page.ID, "")
	if r.Header.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(r.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("html download headers: %v", r.Header)
	}
	if r = owner.download(orgID, img.ID, "?download=1"); !strings.HasPrefix(r.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("forced download: %v", r.Header)
	}

	// Limits and misuse.
	if r := emp.upload(orgID, general, "big.bin", bytes.Repeat([]byte("x"), 1<<20+1)); r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: %d %s", r.status, r.body)
	}
	expectError(t, emp.upload(orgID, general, "empty.txt", nil), http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, emp.do(http.MethodPost, base+"/messages", map[string]any{"body": "again", "attachmentIds": []string{img.ID}}),
		http.StatusUnprocessableEntity, "validation_failed")
	mine := owner.uploaded(orgID, general, "a.txt", []byte("merhaba"))
	expectError(t, emp.do(http.MethodPost, base+"/messages", map[string]any{"body": "x", "attachmentIds": []string{mine.ID}}),
		http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusNoContent, http.MethodDelete, "/api/v1/orgs/"+orgID+"/files/"+mine.ID, nil)

	// The channel's files tab.
	var files struct {
		Files []attachment `json:"files"`
	}
	owner.must(http.StatusOK, http.MethodGet, base+"/files", nil).decode(t, &files)
	if len(files.Files) != 2 {
		t.Fatalf("files = %+v", files.Files)
	}

	// Private channel files stay private.
	secret := owner.createChannel(orgID, map[string]any{"name": "gizli", "visibility": "private"})
	hidden := owner.uploaded(orgID, secret.ID, "plan.txt", []byte("gizli plan"))
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/channels/"+secret.ID+"/messages", map[string]any{"attachmentIds": []string{hidden.ID}})
	if r := emp.download(orgID, hidden.ID, ""); r.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider download: %d", r.StatusCode)
	}

	// Deleting the message deletes its files.
	emp.must(http.StatusNoContent, http.MethodDelete, base+"/messages/"+sent.Message.ID, nil)
	if r := owner.download(orgID, img.ID, ""); r.StatusCode != http.StatusNotFound {
		t.Fatalf("download after delete: %d", r.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(ts.cfg.DataDir, "files", orgID, img.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("file still on disk: %v", err)
	}
}

func TestSearch(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	general := owner.channels(orgID)[0].ID
	secret := owner.createChannel(orgID, map[string]any{"name": "gizli", "visibility": "private"})

	owner.post(orgID, general, "Kubernetes kümesini dün güncelledik.")
	owner.post(orgID, secret.ID, "Kubernetes sertifikaları yenilenecek.")
	emp.post(orgID, general, "Kahve molası, kubernetes sonra.")

	search := func(c *client, query string) []struct {
		Message struct {
			Body string `json:"body"`
		} `json:"message"`
		Channel struct {
			Name string `json:"name"`
		} `json:"channel"`
	} {
		t.Helper()
		var out struct {
			Results []struct {
				Message struct {
					Body string `json:"body"`
				} `json:"message"`
				Channel struct {
					Name string `json:"name"`
				} `json:"channel"`
			} `json:"results"`
		}
		c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/search?q="+url.QueryEscape(query), nil).decode(t, &out)
		return out.Results
	}

	if got := search(owner, "kuber"); len(got) != 3 || got[0].Message.Body != "Kahve molası, kubernetes sonra." {
		t.Fatalf("owner results = %+v", got)
	}
	if got := search(emp, "KUBER"); len(got) != 2 {
		t.Fatalf("private channels must stay out of others' results: %+v", got)
	}
	if got := search(owner, "kubernetes dün"); len(got) != 1 || got[0].Channel.Name != "genel" {
		t.Fatalf("all words must match: %+v", got)
	}
	if got := search(owner, "kubernetes & ! | (:*"); len(got) != 3 {
		t.Fatalf("operators are ignored: %+v", got)
	}
	var byAuthor struct {
		Results []json.RawMessage `json:"results"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/search?q=kubernetes&authorId="+empID, nil).decode(t, &byAuthor)
	if len(byAuthor.Results) != 1 {
		t.Fatalf("author filter = %d results", len(byAuthor.Results))
	}
	expectError(t, owner.do(http.MethodGet, "/api/v1/orgs/"+orgID+"/search?q=%21%21", nil), http.StatusUnprocessableEntity, "validation_failed")
}

func TestArchiveAndRetention(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	general := owner.channels(orgID)[0].ID
	base := "/api/v1/orgs/" + orgID + "/channels/"

	// Archiving makes a channel read-only and takes it off the sidebar.
	old := owner.createChannel(orgID, map[string]any{"name": "eski-proje", "visibility": "public"})
	emp.must(http.StatusOK, http.MethodPost, base+old.ID+"/join", nil)
	msg := emp.post(orgID, old.ID, "Son durum raporu")
	expectError(t, emp.do(http.MethodPost, base+old.ID+"/archive", nil), http.StatusForbidden, "forbidden")
	expectError(t, owner.do(http.MethodPost, base+general+"/archive", nil), http.StatusConflict, "default_channel")
	owner.must(http.StatusOK, http.MethodPost, base+old.ID+"/archive", nil)
	if find(emp.channels(orgID), "eski-proje") != nil {
		t.Fatal("archived channel still in the sidebar")
	}
	var browse struct {
		Channels []struct {
			Name       string  `json:"name"`
			ArchivedAt *string `json:"archivedAt"`
		} `json:"channels"`
	}
	emp.must(http.StatusOK, http.MethodGet, base+"browse", nil).decode(t, &browse)
	last := browse.Channels[len(browse.Channels)-1]
	if last.Name != "eski-proje" || last.ArchivedAt == nil {
		t.Fatalf("browse = %+v", browse.Channels)
	}
	if got := emp.history(orgID, old.ID, ""); len(got.Messages) != 1 {
		t.Fatalf("archived history = %+v", got)
	}
	expectError(t, emp.do(http.MethodPost, base+old.ID+"/messages", map[string]string{"body": "x"}), http.StatusConflict, "channel_archived")
	expectError(t, emp.do(http.MethodPost, base+old.ID+"/messages/"+msg.ID+"/reactions", map[string]string{"emoji": "👍"}), http.StatusConflict, "channel_archived")
	expectError(t, emp.do(http.MethodDelete, base+old.ID+"/messages/"+msg.ID, nil), http.StatusConflict, "channel_archived")
	owner.must(http.StatusOK, http.MethodPost, base+old.ID+"/unarchive", nil)
	if find(emp.channels(orgID), "eski-proje") == nil {
		t.Fatal("restored channel missing from the sidebar")
	}

	// Retention: owners choose it; it is audited.
	retention := "/api/v1/orgs/" + orgID + "/retention"
	expectError(t, emp.do(http.MethodPut, retention, map[string]any{"days": 30}), http.StatusForbidden, "forbidden")
	expectError(t, owner.do(http.MethodPut, retention, map[string]any{"days": 10}), http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusOK, http.MethodPut, retention, map[string]any{"days": 30})
	var current struct {
		Days *int `json:"days"`
	}
	emp.must(http.StatusOK, http.MethodGet, retention, nil).decode(t, &current)
	if current.Days == nil || *current.Days != 30 {
		t.Fatalf("retention = %v", current.Days)
	}

	// Old messages go; an old root with a newer reply stays as a placeholder; old files go.
	gone := owner.post(orgID, general, "Eski duyuru")
	kept := owner.post(orgID, general, "Eski soru")
	emp.postRich(orgID, general, map[string]any{"body": "Yeni yanıt", "parentId": kept.ID})
	recent := owner.post(orgID, general, "Yeni duyuru")
	file := owner.uploaded(orgID, general, "eski.txt", []byte("eski içerik"))
	withFile := owner.postRich(orgID, general, map[string]any{"attachmentIds": []string{file.ID}})
	unsent := owner.uploaded(orgID, general, "taslak.txt", []byte("gönderilmedi"))
	ctx := t.Context()
	if _, err := ts.db.Exec(ctx, `UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ANY ($1::uuid[])`,
		[]string{gone.ID, kept.ID, withFile.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := ts.db.Exec(ctx, `UPDATE attachments SET created_at = now() - interval '2 days' WHERE id = $1`, unsent.ID); err != nil {
		t.Fatal(err)
	}
	files, err := storage.NewDisk(ts.cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := chat.ApplyRetention(ctx, ts.db, files, time.Now()); err != nil {
		t.Fatal(err)
	}
	history := owner.richHistory(orgID, general)
	ids := map[string]richMessage{}
	for _, m := range history {
		ids[m.ID] = m
	}
	if _, ok := ids[gone.ID]; ok {
		t.Fatal("expired message kept")
	}
	if m, ok := ids[kept.ID]; !ok || !m.Deleted || m.Thread == nil || m.Thread.ReplyCount != 1 {
		t.Fatalf("root with a newer reply = %+v", m)
	}
	if _, ok := ids[recent.ID]; !ok {
		t.Fatal("recent message removed")
	}
	if _, ok := ids[withFile.ID]; ok {
		t.Fatal("expired message with a file kept")
	}
	for _, id := range []string{file.ID, unsent.ID} {
		if _, err := os.Stat(filepath.Join(ts.cfg.DataDir, "files", orgID, id)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("file %s still on disk: %v", id, err)
		}
	}
}
