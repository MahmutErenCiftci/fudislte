package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// cmdSetupCode asks the API to email the first-run confirmation code. With
// FUDISLTE_MAIL_TRANSPORT=log the code is printed to the API log, where the calling script
// reads it.
func cmdSetupCode(args []string) error {
	fs := flag.NewFlagSet("setup-code", flag.ExitOnError)
	base := fs.String("base", "http://127.0.0.1:8091", "API base URL")
	email := fs.String("email", "", "email address of the first administrator")
	_ = fs.Parse(args)
	if *email == "" {
		return errors.New("setup-code: -email is required")
	}
	token, err := requireEnv("FUDISLTE_LOADTEST_SETUP_TOKEN")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := newClient(*base, defaultCookie, 30*time.Second, 2)
	return c.json(ctx, http.MethodPost, "/api/v1/setup/code", "", map[string]string{
		"setupToken": token, "email": *email,
	}, nil)
}

// cmdSetup completes first-run setup and stores the owner's session in an accounts file.
// It prints org_id=… and user_id=… for the calling script.
func cmdSetup(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	base := fs.String("base", "http://127.0.0.1:8091", "API base URL")
	email := fs.String("email", "", "email address used with setup-code")
	name := fs.String("name", "Load Test Owner", "display name of the first administrator")
	orgName := fs.String("org", "Load Test", "name of the first workspace")
	out := fs.String("out", "", "accounts file for the owner's session (mode 0600)")
	cookie := fs.String("cookie", defaultCookie, "session cookie name")
	_ = fs.Parse(args)
	if *email == "" || *out == "" {
		return errors.New("setup: -email and -out are required")
	}
	token, err := requireEnv("FUDISLTE_LOADTEST_SETUP_TOKEN")
	if err != nil {
		return err
	}
	code, err := requireEnv("FUDISLTE_LOADTEST_SETUP_CODE")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := newClient(*base, *cookie, 30*time.Second, 2)
	body, err := json.Marshal(map[string]string{
		"setupToken": token, "organizationName": *orgName, "displayName": *name, "email": *email, "code": code,
	})
	if err != nil {
		return err
	}
	resp, data, err := c.send(ctx, http.MethodPost, "/api/v1/setup", "", "application/json", body)
	if err != nil {
		return err
	}
	var res struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	if err := json.Unmarshal(data, &res); err != nil {
		return fmt.Errorf("setup: decode response: %w", err)
	}
	var session string
	for _, ck := range resp.Cookies() {
		if strings.HasSuffix(ck.Name, "fudislte_session") && ck.Value != "" {
			session = ck.Value
		}
	}
	if session == "" || res.User.ID == "" || res.Organization.ID == "" {
		return errors.New("setup: the response has no session cookie, user or organization")
	}
	if err := writeAccounts(*out, []account{{UserID: res.User.ID, Email: *email, Token: session}}, false); err != nil {
		return err
	}
	fmt.Printf("org_id=%s\nuser_id=%s\n", res.Organization.ID, res.User.ID)
	return nil
}
