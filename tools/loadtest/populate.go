package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

type channelInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	IsDefault bool   `json:"isDefault"`
}

type messageRef struct {
	ID        string
	ChannelID string
	Author    account
}

// cmdPopulate fills a workspace with the kinds of rows and files a real one has, through
// the same API calls the web app makes, so a restore drill has something to compare.
func cmdPopulate(args []string) error {
	fs := flag.NewFlagSet("populate", flag.ExitOnError)
	base := fs.String("base", "http://127.0.0.1:8091", "API base URL")
	orgID := fs.String("org", "", "workspace ID")
	tokens := fs.String("tokens", "", "accounts file of workspace members (at least 4)")
	cookie := fs.String("cookie", defaultCookie, "session cookie name")
	messages := fs.Int("messages", 150, "number of channel messages (thread replies included)")
	files := fs.Int("files", 6, "number of attachments sent with messages (one more stays unsent)")
	_ = fs.Parse(args)
	if !uuidPattern.MatchString(*orgID) || *tokens == "" {
		return errors.New("populate: -org and -tokens are required")
	}
	accs, err := readAccounts(*tokens)
	if err != nil {
		return err
	}
	if len(accs) < 4 {
		return errors.New("populate: the accounts file needs at least 4 members")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	c := newClient(*base, *cookie, 2*time.Minute, 8)
	c.retry429 = true
	org := "/api/v1/orgs/" + *orgID
	stats := map[string]int{}

	var list struct {
		Channels []channelInfo `json:"channels"`
	}
	if err := c.json(ctx, http.MethodGet, org+"/channels", accs[0].Token, nil, &list); err != nil {
		return err
	}
	var general string
	for _, ch := range list.Channels {
		if ch.IsDefault {
			general = ch.ID
		}
	}
	if general == "" {
		return errors.New("populate: the workspace has no default channel")
	}

	everyone := make([]string, 0, len(accs))
	for _, a := range accs[1:] {
		everyone = append(everyone, a.UserID)
	}
	var created struct {
		Channel channelInfo `json:"channel"`
	}
	if err := c.json(ctx, http.MethodPost, org+"/channels", accs[0].Token, map[string]any{
		"name": "drill-proje", "topic": "Geri yükleme tatbikatı — restore drill fixture", "visibility": "public", "memberIds": everyone,
	}, &created); err != nil {
		return err
	}
	project := created.Channel.ID
	if err := c.json(ctx, http.MethodPost, org+"/channels", accs[0].Token, map[string]any{
		"name": "drill-gizli", "visibility": "private", "memberIds": []string{accs[1].UserID, accs[2].UserID},
	}, &created); err != nil {
		return err
	}
	private := created.Channel.ID
	stats["channels"] = 2

	bodies := []string{
		"Merhaba ekip! Sprint planlaması yarın 10:00'da. 🚀",
		"Yedekleme tatbikatı için örnek mesaj: çalışıyor mu? Ğ Ü Ş İ Ö Ç ğüşıöç",
		"Multi-line message\nsecond line\n\tindented with a tab",
		"Release notes are in the files tab, please review before Friday.",
		"Kod incelemesi bekleniyor 👀 `go test ./...` yeşil.",
		"Customer call moved to 15:30, I will share the recording.",
	}
	post := func(a account, channel, body string, parent *string, attachments []string) (string, error) {
		in := map[string]any{"body": body}
		if parent != nil {
			in["parentId"] = *parent
		}
		if len(attachments) > 0 {
			in["attachmentIds"] = attachments
		}
		var res struct {
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
		}
		err := c.json(ctx, http.MethodPost, org+"/channels/"+channel+"/messages", a.Token, in, &res)
		return res.Message.ID, err
	}

	var roots []messageRef
	emojis := []string{"👍", "🎉", "❤️", "🚀"}
	for i := 0; i < *messages; i++ {
		author := accs[i%len(accs)]
		channel := general
		switch {
		case i%10 == 9:
			author, channel = accs[1+(i/10)%2], private
		case i%3 == 2:
			channel = project
		}
		body := bodies[i%len(bodies)]
		if i%7 == 3 {
			body = fmt.Sprintf("<@%s> %s", accs[(i+1)%len(accs)].UserID, body)
		}
		var parent *string
		if i%6 == 5 && len(roots) > 0 {
			// Reply to the latest root of the same channel, if any.
			for j := len(roots) - 1; j >= 0; j-- {
				if roots[j].ChannelID == channel {
					parent = &roots[j].ID
					break
				}
			}
		}
		id, err := post(author, channel, fmt.Sprintf("%s (#%d)", body, i+1), parent, nil)
		if err != nil {
			return err
		}
		if parent != nil {
			stats["replies"]++
		} else {
			stats["messages"]++
			roots = append(roots, messageRef{ID: id, ChannelID: channel, Author: author})
		}
		if i%4 == 0 && channel != private {
			reactor := accs[(i+2)%len(accs)]
			if err := c.json(ctx, http.MethodPost, org+"/channels/"+channel+"/messages/"+id+"/reactions", reactor.Token,
				map[string]string{"emoji": emojis[i%len(emojis)]}, nil); err != nil {
				return err
			}
			stats["reactions"]++
		}
	}

	// An edited, a pinned and a deleted message.
	first := roots[0]
	if err := c.json(ctx, http.MethodPatch, org+"/channels/"+first.ChannelID+"/messages/"+first.ID, first.Author.Token,
		map[string]string{"body": "Düzenlendi: " + bodies[0]}, nil); err != nil {
		return err
	}
	stats["edited"]++
	if err := c.json(ctx, http.MethodPut, org+"/channels/"+first.ChannelID+"/messages/"+first.ID+"/pin", accs[0].Token, nil, nil); err != nil {
		return err
	}
	stats["pinned"]++
	gone, err := post(accs[3], general, "Bu mesaj silinecek / this one gets deleted", nil, nil)
	if err != nil {
		return err
	}
	if err := c.json(ctx, http.MethodDelete, org+"/channels/"+general+"/messages/"+gone, accs[3].Token, nil, nil); err != nil {
		return err
	}
	stats["deleted"]++

	// Attachments: sizes from one byte to a few megabytes, Turkish file names, random bytes
	// (so the content cannot be compressed or deduplicated away).
	sizes := []int{1, 913, 64 << 10, 1<<20 + 7, 3 << 20, 250 << 10}
	names := []string{"tek-bayt.bin", "toplantı-notları.txt", "şema-çizimi.bin", "rapor Ğ Ü.bin", "kayıt.bin", "logo.bin"}
	var pending []string
	for i := 0; i < *files; i++ {
		// Pairs of files from the same uploader, who then sends them in one message.
		uploader := accs[1+(i/2)%2]
		data := make([]byte, sizes[i%len(sizes)])
		_, _ = rand.Read(data)
		if strings.HasSuffix(names[i%len(names)], ".txt") {
			data = []byte(strings.Repeat("Toplantı notları — çalışma planı, ğüşıöç ĞÜŞİÖÇ.\n", 18))
		}
		id, err := upload(ctx, c, org+"/channels/"+general+"/files", uploader.Token, fmt.Sprintf("%02d-%s", i+1, names[i%len(names)]), data)
		if err != nil {
			return err
		}
		stats["files"]++
		stats["file_bytes"] += len(data)
		pending = append(pending, id)
		// Two files per message, sent by the uploader.
		if len(pending) == 2 || i == *files-1 {
			if _, err := post(uploader, general, fmt.Sprintf("Dosyalar ektedir (%d)", len(pending)), nil, pending); err != nil {
				return err
			}
			stats["messages"]++
			pending = nil
		}
	}
	// One upload that is never sent: it lives in the database and on disk until the
	// janitor removes it a day later, and a backup must carry it too.
	unsent := make([]byte, 4096)
	_, _ = rand.Read(unsent)
	if _, err := upload(ctx, c, org+"/channels/"+general+"/files", accs[3].Token, "gönderilmedi.bin", unsent); err != nil {
		return err
	}
	stats["unsent_files"]++
	stats["file_bytes"] += len(unsent)

	// A direct conversation.
	var conv struct {
		Conversation channelInfo `json:"conversation"`
	}
	if err := c.json(ctx, http.MethodPost, org+"/conversations", accs[1].Token, map[string]any{"userIds": []string{accs[2].UserID}}, &conv); err != nil {
		return err
	}
	for i := 0; i < 6; i++ {
		a := accs[1+i%2]
		if _, err := post(a, conv.Conversation.ID, fmt.Sprintf("Özel mesaj %d — direct message", i+1), nil, nil); err != nil {
			return err
		}
		stats["dm_messages"]++
	}

	fmt.Printf("populate: channels=%d messages=%d replies=%d reactions=%d edited=%d pinned=%d deleted=%d files=%d unsent_files=%d file_bytes=%d dm_messages=%d\n",
		stats["channels"], stats["messages"], stats["replies"], stats["reactions"], stats["edited"], stats["pinned"], stats["deleted"],
		stats["files"], stats["unsent_files"], stats["file_bytes"], stats["dm_messages"])
	return nil
}

// upload sends one file the way the web app does (multipart field "file").
func upload(ctx context.Context, c *client, path, token, name string, data []byte) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", name)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := mw.Close(); err != nil {
		return "", err
	}
	_, body, err := c.send(ctx, http.MethodPost, path, token, mw.FormDataContentType(), buf.Bytes())
	if err != nil {
		return "", err
	}
	var res struct {
		Attachment struct {
			ID string `json:"id"`
		} `json:"attachment"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return "", err
	}
	if res.Attachment.ID == "" {
		return "", errors.New("upload: response has no attachment id")
	}
	return res.Attachment.ID, nil
}
