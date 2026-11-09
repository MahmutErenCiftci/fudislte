// Command fudislte-api runs the FUDISLTE API server.
//
//	fudislte-api [serve]     run migrations (unless disabled) and serve HTTP
//	fudislte-api migrate     apply database migrations and exit
//	fudislte-api mailtest TO send one test email with the configured SMTP settings
//	fudislte-api healthcheck probe the local /healthz endpoint (for container health checks)
//	fudislte-api version     print the version
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"fudislte/api/internal/config"
	"fudislte/api/internal/database"
	"fudislte/api/internal/mail"
	"fudislte/api/internal/realtime"
	"fudislte/api/internal/server"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "fudislte-api:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "version":
		fmt.Println(version)
		return nil
	case "healthcheck":
		return healthcheck()
	case "serve", "migrate", "mailtest":
	default:
		return fmt.Errorf("unknown command %q (expected serve, migrate, mailtest, healthcheck or version)", cmd)
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	slog.SetDefault(newLogger(cfg))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "migrate":
		return database.Migrate(ctx, cfg.DatabaseURL)
	case "mailtest":
		return mailTest(ctx, cfg, args[1:])
	}
	return serve(ctx, cfg)
}

// mailTest sends one message through the configured SMTP relay so operators can check
// the settings before anyone depends on a sign-in code.
func mailTest(ctx context.Context, cfg config.Config, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: fudislte-api mailtest <recipient@example.com>")
	}
	if cfg.Mail.Transport != "smtp" {
		return errors.New("FUDISLTE_MAIL_TRANSPORT is not smtp, so nothing would be delivered")
	}
	sender, err := newMailSender(cfg.Mail)
	if err != nil {
		return err
	}
	to := strings.TrimSpace(args[0])
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := sender.Send(ctx, mail.Test(to, cfg.PublicURL, time.Now())); err != nil {
		return fmt.Errorf("test email to %s failed: %w", to, err)
	}
	fmt.Printf("Test email sent to %s via %s:%d (%s).\n", to, cfg.Mail.SMTPHost, cfg.Mail.SMTPPort, cfg.Mail.SMTPTLS)
	return nil
}

func serve(ctx context.Context, cfg config.Config) error {
	if cfg.MigrateOnStart {
		if err := database.Migrate(ctx, cfg.DatabaseURL); err != nil {
			return err
		}
	}
	pool, err := database.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	sender, err := newMailSender(cfg.Mail)
	if err != nil {
		return err
	}
	outbox := mail.NewOutbox(sender)
	defer func() {
		// Let queued sign-in codes and invitations go out before exiting.
		waitCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		outbox.Wait(waitCtx)
	}()

	hub := realtime.NewHub()
	handler, err := server.New(ctx, server.Deps{DB: pool, Config: cfg, Version: version, Outbox: outbox, Hub: hub})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	// Event streams never finish on their own; end them so Shutdown can complete.
	srv.RegisterOnShutdown(hub.Close)

	errCh := make(chan error, 1)
	go func() {
		slog.Info("fudislte api listening", "addr", cfg.HTTPAddr, "version", version)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func newMailSender(m config.Mail) (mail.Sender, error) {
	if m.Transport == "log" {
		slog.Warn("FUDISLTE_MAIL_TRANSPORT=log: emails, including sign-in codes, are written to this log and not delivered (development only)")
		return mail.LogSender{}, nil
	}
	return mail.NewSMTPSender(mail.SMTPConfig{
		Host: m.SMTPHost, Port: m.SMTPPort, Username: m.SMTPUsername, Password: m.SMTPPassword, TLS: m.SMTPTLS, From: m.From,
	})
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, opts))
}

func healthcheck() error {
	addr := os.Getenv("FUDISLTE_HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unhealthy: status %d", resp.StatusCode)
	}
	return nil
}
