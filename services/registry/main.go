// Command fudislte-registry receives the registrations that FUDISLTE servers send when
// their administrators agree to it, and lists them on a password-protected page for the
// project. A registration carries the organization's name, a contact email, the number
// of users and the version — nothing else is received or stored. Standard library only.
//
//	fudislte-registry [serve]     serve HTTP
//	fudislte-registry healthcheck probe the local /healthz endpoint (container health checks)
//
// Environment:
//
//	FUDISLTE_REGISTRY_ADMIN_PASSWORD  password for the list page (required, at least 12 characters)
//	FUDISLTE_REGISTRY_ADDR            listen address (default :8080)
//	FUDISLTE_REGISTRY_DATA_DIR        where instances.json is kept (default /var/lib/fudislte-registry)
//	FUDISLTE_REGISTRY_TRUST_PROXY     true behind a reverse proxy that appends X-Forwarded-For
//	FUDISLTE_REGISTRY_MAX_INSTANCES   most registrations kept (default 100000)
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
	"strconv"
	"syscall"
	"time"
	"unicode/utf8"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "fudislte-registry:", err)
		os.Exit(1)
	}
}

func valueOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	addr := valueOr("FUDISLTE_REGISTRY_ADDR", ":8080")
	switch cmd {
	case "healthcheck":
		return healthcheck(addr)
	case "serve":
	default:
		return fmt.Errorf("unknown command %q (expected serve or healthcheck)", cmd)
	}

	password := os.Getenv("FUDISLTE_REGISTRY_ADMIN_PASSWORD")
	if utf8.RuneCountInString(password) < 12 {
		return errors.New("FUDISLTE_REGISTRY_ADMIN_PASSWORD must be at least 12 characters")
	}
	trustProxy, err := strconv.ParseBool(valueOr("FUDISLTE_REGISTRY_TRUST_PROXY", "false"))
	if err != nil {
		return errors.New("FUDISLTE_REGISTRY_TRUST_PROXY must be true or false")
	}
	maxInstances, err := strconv.Atoi(valueOr("FUDISLTE_REGISTRY_MAX_INSTANCES", "100000"))
	if err != nil || maxInstances < 1 {
		return errors.New("FUDISLTE_REGISTRY_MAX_INSTANCES must be a positive number")
	}
	store, err := OpenStore(valueOr("FUDISLTE_REGISTRY_DATA_DIR", "/var/lib/fudislte-registry"), maxInstances)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{
		Addr:              addr,
		Handler:           NewServer(store, password, trustProxy).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	saving, stopSaving := context.WithCancel(context.Background())
	saved := make(chan struct{})
	go func() {
		store.Run(saving, 5*time.Second)
		close(saved)
	}()
	// Pending reports reach the disk however the server stops.
	defer func() {
		stopSaving()
		<-saved
	}()

	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("fudislte registry listening", "addr", addr, "instances", len(store.List()))
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

func healthcheck(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("healthz returned %d", resp.StatusCode)
	}
	return nil
}
