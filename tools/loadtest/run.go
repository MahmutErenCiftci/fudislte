package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The API allows each person 5 messages per second after a burst of 20
// (internal/chat: postsByUser); faster posters measure the rate limiter, not the system.
const perUserPostLimit = 5.0

// streamRetry is the reconnect delay the API announces to browsers ("retry: 3000").
const streamRetry = 3 * time.Second

type runOptions struct {
	base, org, channel, tokens, cookie, label, jsonOut string
	users, posters, bodySize, apiPID                   int
	rate                                               float64
	duration, ramp, settle, drain, readyTimeout        time.Duration
}

type runner struct {
	opt     runOptions
	tag     string // "lt <run-id> " starts every test message
	padding string
	start   time.Time // monotonic origin of every timestamp below
	total   int

	sent      []atomic.Int64 // when message i was sent, ns since start; 0 = not yet
	ok        []atomic.Bool  // message i was accepted (201)
	delivered []atomic.Int32 // deliveries of message i to members other than its author
	slowest   []atomic.Int64 // latest delivery of message i, ns after it was sent

	deliveredTotal atomic.Int64
	readyCount     atomic.Int64

	sse     *http.Client
	posts   *http.Client
	postURL string

	mu       sync.Mutex
	postLat  []int64
	postErrs map[string]int
}

// stream is one person's live event stream. Its fields are owned by its goroutine until
// the run ends.
type stream struct {
	acc         account
	ready       bool
	connectNS   int64
	latencies   []int64
	seen        []uint64 // bitset of delivered message numbers
	events      map[string]int
	disconnects int
	reconnects  int
	connectErrs int
	duplicates  int
	selfEchoes  int
	foreign     int
	parseErrs   int
	lastErr     string
}

func cmdRun(args []string) error {
	var o runOptions
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	fs.StringVar(&o.base, "base", "http://127.0.0.1:8091", "API base URL")
	fs.StringVar(&o.org, "org", "", "workspace ID")
	fs.StringVar(&o.channel, "channel", "", "channel ID (default: the workspace's default channel)")
	fs.StringVar(&o.tokens, "tokens", "", "accounts file of workspace members")
	fs.StringVar(&o.cookie, "cookie", defaultCookie, "session cookie name")
	fs.StringVar(&o.label, "label", "", "scenario name for the report")
	fs.StringVar(&o.jsonOut, "json", "", "also write the results to this JSON file")
	fs.IntVar(&o.users, "users", 50, "live event streams, one per member (the first N accounts)")
	fs.IntVar(&o.posters, "posters", 10, "members among them who post messages")
	fs.Float64Var(&o.rate, "rate", 10, "messages per second, across all posters")
	fs.DurationVar(&o.duration, "duration", time.Minute, "how long to post")
	fs.DurationVar(&o.ramp, "ramp", 5*time.Second, "spread the stream connections over this time")
	fs.DurationVar(&o.settle, "settle", 5*time.Second, "pause between the last connection and the first message")
	fs.DurationVar(&o.drain, "drain", 10*time.Second, "how long to wait for outstanding events after the last message")
	fs.DurationVar(&o.readyTimeout, "ready-timeout", time.Minute, "how long to wait for every stream to be ready")
	fs.IntVar(&o.bodySize, "body-bytes", 120, "approximate message size")
	fs.IntVar(&o.apiPID, "api-pid", 0, "API process ID, to report its CPU and memory use (Linux)")
	_ = fs.Parse(args)

	accs, err := readAccounts(o.tokens)
	if err != nil {
		return err
	}
	switch {
	case !uuidPattern.MatchString(o.org):
		return errors.New("run: -org must be a workspace UUID")
	case o.users < 2 || o.users > len(accs):
		return fmt.Errorf("run: -users must be between 2 and %d (accounts in %s)", len(accs), o.tokens)
	case o.posters < 1 || o.posters > o.users:
		return errors.New("run: -posters must be between 1 and -users")
	case o.rate <= 0 || o.duration <= 0:
		return errors.New("run: -rate and -duration must be positive")
	}
	if per := o.rate / float64(o.posters); per > perUserPostLimit {
		fmt.Fprintf(os.Stderr, "warning: %.1f messages/s per poster exceeds the API's per-user limit of %.0f/s; expect HTTP 429\n", per, perUserPostLimit)
	}
	accs = accs[:o.users]

	if o.channel == "" {
		c := newClient(o.base, o.cookie, 30*time.Second, 2)
		var list struct {
			Channels []channelInfo `json:"channels"`
		}
		if err := c.json(context.Background(), http.MethodGet, "/api/v1/orgs/"+o.org+"/channels", accs[0].Token, nil, &list); err != nil {
			return err
		}
		for _, ch := range list.Channels {
			if ch.IsDefault {
				o.channel = ch.ID
			}
		}
		if o.channel == "" {
			return errors.New("run: the workspace has no default channel")
		}
	}

	r := &runner{opt: o, tag: "lt " + randomHex(4) + " ", postErrs: map[string]int{}}
	r.total = int(math.Round(o.rate * o.duration.Seconds()))
	r.padding = strings.Repeat("x", max(1, o.bodySize-len(r.tag)-8))
	r.sent = make([]atomic.Int64, r.total)
	r.ok = make([]atomic.Bool, r.total)
	r.delivered = make([]atomic.Int32, r.total)
	r.slowest = make([]atomic.Int64, r.total)
	r.postURL = strings.TrimRight(o.base, "/") + "/api/v1/orgs/" + o.org + "/channels/" + o.channel + "/messages"
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	r.sse = &http.Client{Transport: &http.Transport{
		Proxy: nil, DialContext: dialer.DialContext, DisableCompression: true,
		MaxIdleConnsPerHost: o.users, ResponseHeaderTimeout: 30 * time.Second,
	}}
	r.posts = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		Proxy: nil, DialContext: dialer.DialContext, DisableCompression: true,
		MaxIdleConns: 4 * o.posters, MaxIdleConnsPerHost: 4 * o.posters, IdleConnTimeout: 90 * time.Second,
	}}

	logf("run %s: %d streams, %d posters, %.1f msg/s for %s (%d messages) to channel %s",
		strings.TrimSpace(r.tag[3:]), o.users, o.posters, o.rate, o.duration, r.total, o.channel)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.start = time.Now()
	streams := make([]*stream, o.users)
	var wg sync.WaitGroup
	for i, a := range accs {
		s := &stream{acc: a, events: map[string]int{}, seen: make([]uint64, r.total/64+1)}
		streams[i] = s
		delay := time.Duration(0)
		if o.users > 1 {
			delay = o.ramp * time.Duration(i) / time.Duration(o.users)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.runStream(ctx, s, delay)
		}()
	}
	readyDeadline := time.Now().Add(o.ramp + o.readyTimeout)
	for r.readyCount.Load() < int64(o.users) && time.Now().Before(readyDeadline) {
		time.Sleep(20 * time.Millisecond)
	}
	readyAfter := time.Since(r.start)
	logf("streams: %d of %d ready after %s", r.readyCount.Load(), o.users, readyAfter.Round(time.Millisecond))
	time.Sleep(o.settle)

	usage := startResources(o.apiPID)
	postStart := time.Now()
	interval := time.Duration(float64(time.Second) / o.rate)
	var pwg sync.WaitGroup
	for k := 0; k < r.total; k++ {
		if d := time.Until(postStart.Add(time.Duration(k) * interval)); d > 0 {
			time.Sleep(d)
		}
		poster := accs[k%o.posters]
		pwg.Add(1)
		go func() {
			defer pwg.Done()
			r.post(ctx, k, poster)
		}()
	}
	pwg.Wait()
	postWindow := time.Since(postStart)
	okPosts := 0
	for i := range r.ok {
		if r.ok[i].Load() {
			okPosts++
		}
	}
	expected := int64(okPosts) * int64(o.users-1)
	logf("posting done after %s: %d of %d accepted; waiting up to %s for events", postWindow.Round(time.Millisecond), okPosts, r.total, o.drain)
	drainDeadline := time.Now().Add(o.drain)
	for r.deliveredTotal.Load() < expected && time.Now().Before(drainDeadline) {
		time.Sleep(50 * time.Millisecond)
	}
	res := usage.stop()
	cancel()
	wg.Wait()

	return r.report(streams, readyAfter, postWindow, okPosts, expected, res)
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "%s "+format+"\n", append([]any{time.Now().Format("15:04:05.000")}, args...)...)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// runStream keeps one event stream open until ctx ends, reconnecting like a browser.
func (r *runner) runStream(ctx context.Context, s *stream, delay time.Duration) {
	if !sleepCtx(ctx, delay) {
		return
	}
	for {
		connected, err := r.consume(ctx, s, time.Now())
		if ctx.Err() != nil {
			return
		}
		if connected {
			s.disconnects++
		} else {
			s.connectErrs++
		}
		if err != nil {
			s.lastErr = err.Error()
		}
		if !sleepCtx(ctx, streamRetry) {
			return
		}
		s.reconnects++
	}
}

// consume reads one connection of the event stream. It reports whether the stream was
// established (HTTP 200).
func (r *runner) consume(ctx context.Context, s *stream, began time.Time) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(r.opt.base, "/")+"/api/v1/events", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "fudislte-loadtest")
	req.AddCookie(&http.Cookie{Name: r.opt.cookie, Value: s.acc.Token})
	resp, err := r.sse.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return false, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	var (
		typ  string
		data []byte
	)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 { // end of one event
			if typ != "" || len(data) > 0 {
				r.handle(s, typ, data, began)
			}
			typ, data = "", data[:0]
			continue
		}
		if line[0] == ':' { // comment, e.g. the heartbeat
			continue
		}
		field, value, _ := bytes.Cut(line, []byte(":"))
		value = bytes.TrimPrefix(value, []byte(" "))
		switch string(field) {
		case "event":
			typ = string(value)
		case "data":
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, value...)
		}
	}
	if err := sc.Err(); err != nil {
		return true, err
	}
	return true, io.EOF // the server ended the stream
}

func (r *runner) handle(s *stream, typ string, data []byte, began time.Time) {
	now := time.Since(r.start).Nanoseconds()
	if typ == "" {
		typ = "message"
	}
	s.events[typ]++
	switch typ {
	case "ready":
		if !s.ready {
			s.ready = true
			s.connectNS = time.Since(began).Nanoseconds()
			r.readyCount.Add(1)
		}
	case "message.created":
		if !bytes.Contains(data, []byte(r.tag)) {
			s.foreign++
			return
		}
		var ev struct {
			Message struct {
				Body   string `json:"body"`
				Author *struct {
					ID string `json:"id"`
				} `json:"author"`
			} `json:"message"`
		}
		if err := json.Unmarshal(data, &ev); err != nil {
			s.parseErrs++
			return
		}
		seq, ok := r.seqOf(ev.Message.Body)
		if !ok {
			s.foreign++
			return
		}
		if ev.Message.Author != nil && ev.Message.Author.ID == s.acc.UserID {
			s.selfEchoes++
			return
		}
		sentAt := r.sent[seq].Load()
		if sentAt == 0 {
			s.foreign++
			return
		}
		word, bit := seq/64, uint64(1)<<(seq%64)
		if s.seen[word]&bit != 0 {
			s.duplicates++
			return
		}
		s.seen[word] |= bit
		lat := now - sentAt
		s.latencies = append(s.latencies, lat)
		r.delivered[seq].Add(1)
		r.deliveredTotal.Add(1)
		for {
			cur := r.slowest[seq].Load()
			if lat <= cur || r.slowest[seq].CompareAndSwap(cur, lat) {
				break
			}
		}
	}
}

func (r *runner) seqOf(body string) (int, bool) {
	rest, ok := strings.CutPrefix(body, r.tag)
	if !ok {
		return 0, false
	}
	if end := strings.IndexByte(rest, ' '); end >= 0 {
		rest = rest[:end]
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n < 0 || n >= r.total {
		return 0, false
	}
	return n, true
}

func (r *runner) post(ctx context.Context, seq int, a account) {
	payload, _ := json.Marshal(map[string]string{"body": fmt.Sprintf("%s%d %s", r.tag, seq, r.padding)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.postURL, bytes.NewReader(payload))
	if err != nil {
		r.postError("request: " + err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "fudislte-loadtest")
	req.AddCookie(&http.Cookie{Name: r.opt.cookie, Value: a.Token})
	sentAt := time.Since(r.start).Nanoseconds()
	r.sent[seq].Store(sentAt)
	resp, err := r.posts.Do(req)
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			r.postError("timeout")
		} else {
			r.postError("network error")
		}
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	elapsed := time.Since(r.start).Nanoseconds() - sentAt
	if resp.StatusCode != http.StatusCreated {
		r.postError(fmt.Sprintf("HTTP %d", resp.StatusCode))
		return
	}
	r.ok[seq].Store(true)
	r.mu.Lock()
	r.postLat = append(r.postLat, elapsed)
	r.mu.Unlock()
}

func (r *runner) postError(kind string) {
	r.mu.Lock()
	r.postErrs[kind]++
	r.mu.Unlock()
}

// Results, as printed and as written with -json.
type runResult struct {
	Label     string    `json:"label"`
	StartedAt time.Time `json:"started_at"`
	Options   struct {
		Users           int     `json:"users"`
		Posters         int     `json:"posters"`
		RatePerSecond   float64 `json:"rate_per_second"`
		DurationSeconds float64 `json:"duration_seconds"`
		BodyBytes       int     `json:"body_bytes"`
	} `json:"options"`
	Streams struct {
		Requested         int     `json:"requested"`
		Ready             int     `json:"ready"`
		ReadyAfterSeconds float64 `json:"ready_after_seconds"`
		Connect           summary `json:"time_to_ready"`
		Disconnects       int     `json:"disconnects"`
		Reconnects        int     `json:"reconnects"`
		ConnectErrors     int     `json:"connect_errors"`
		LastError         string  `json:"last_error,omitempty"`
	} `json:"streams"`
	Posts struct {
		Scheduled     int            `json:"scheduled"`
		Accepted      int            `json:"accepted"`
		Errors        map[string]int `json:"errors"`
		Latency       summary        `json:"latency"`
		WindowSeconds float64        `json:"window_seconds"`
		PerSecond     float64        `json:"accepted_per_second"`
	} `json:"posts"`
	Delivery struct {
		Expected         int64   `json:"expected"`
		Received         int64   `json:"received"`
		Dropped          int64   `json:"dropped"`
		DroppedPercent   float64 `json:"dropped_percent"`
		Duplicates       int     `json:"duplicates"`
		CompleteMessages int     `json:"messages_reaching_everyone"`
		Latency          summary `json:"latency"`
		Fanout           summary `json:"time_to_last_recipient"`
		PerSecond        float64 `json:"events_per_second"`
	} `json:"delivery"`
	Events    map[string]int `json:"events_by_type"`
	Resources resourceResult `json:"resources"`
}

func (r *runner) report(streams []*stream, readyAfter, postWindow time.Duration, okPosts int, expected int64, usage resourceResult) error {
	var res runResult
	res.Label = r.opt.label
	res.StartedAt = r.start.UTC()
	res.Options.Users, res.Options.Posters, res.Options.RatePerSecond = r.opt.users, r.opt.posters, r.opt.rate
	res.Options.DurationSeconds, res.Options.BodyBytes = r.opt.duration.Seconds(), len(r.tag)+8+len(r.padding)

	var connects, latencies []int64
	res.Events = map[string]int{}
	selfEchoes, foreign, parseErrs := 0, 0, 0
	for _, s := range streams {
		if s.ready {
			res.Streams.Ready++
			connects = append(connects, s.connectNS)
		}
		res.Streams.Disconnects += s.disconnects
		res.Streams.Reconnects += s.reconnects
		res.Streams.ConnectErrors += s.connectErrs
		if s.lastErr != "" && res.Streams.LastError == "" {
			res.Streams.LastError = s.lastErr
		}
		res.Delivery.Duplicates += s.duplicates
		selfEchoes += s.selfEchoes
		foreign += s.foreign
		parseErrs += s.parseErrs
		latencies = append(latencies, s.latencies...)
		for k, v := range s.events {
			res.Events[k] += v
		}
	}
	res.Streams.Requested = r.opt.users
	res.Streams.ReadyAfterSeconds = readyAfter.Seconds()
	res.Streams.Connect = summarize(connects)

	res.Posts.Scheduled, res.Posts.Accepted, res.Posts.Errors = r.total, okPosts, r.postErrs
	res.Posts.Latency = summarize(r.postLat)
	res.Posts.WindowSeconds = postWindow.Seconds()
	res.Posts.PerSecond = float64(okPosts) / postWindow.Seconds()

	var received int64
	var fanout []int64
	for i := range r.ok {
		if !r.ok[i].Load() {
			continue
		}
		n := int64(r.delivered[i].Load())
		received += n
		if n == int64(r.opt.users-1) {
			res.Delivery.CompleteMessages++
			fanout = append(fanout, r.slowest[i].Load())
		}
	}
	res.Delivery.Expected, res.Delivery.Received = expected, received
	res.Delivery.Dropped = expected - received
	if expected > 0 {
		res.Delivery.DroppedPercent = 100 * float64(res.Delivery.Dropped) / float64(expected)
	}
	res.Delivery.Latency = summarize(latencies)
	res.Delivery.Fanout = summarize(fanout)
	res.Delivery.PerSecond = float64(received) / postWindow.Seconds()
	res.Resources = usage

	w := os.Stdout
	fmt.Fprintf(w, "== %s\n", firstNonEmpty(r.opt.label, "load test"))
	fmt.Fprintf(w, "scenario   %d members with a live stream, %d posting, %.1f msg/s target for %s, ~%d-byte messages\n",
		r.opt.users, r.opt.posters, r.opt.rate, r.opt.duration, res.Options.BodyBytes)
	fmt.Fprintf(w, "streams    %d/%d ready after %.2fs; time to ready %s\n", res.Streams.Ready, r.opt.users, readyAfter.Seconds(), res.Streams.Connect)
	fmt.Fprintf(w, "           disconnects %d, reconnects %d, connect errors %d%s\n", res.Streams.Disconnects, res.Streams.Reconnects,
		res.Streams.ConnectErrors, suffix(" (last: ", res.Streams.LastError, ")"))
	fmt.Fprintf(w, "posts      %d/%d accepted in %.1fs = %.1f msg/s; errors: %s\n", okPosts, r.total, postWindow.Seconds(), res.Posts.PerSecond, formatCounts(r.postErrs))
	fmt.Fprintf(w, "post latency      %s\n", res.Posts.Latency)
	fmt.Fprintf(w, "delivery   %d/%d events to other members (%.3f%% dropped, %d duplicates), %.0f events/s; %d/%d messages reached everyone\n",
		received, expected, res.Delivery.DroppedPercent, res.Delivery.Duplicates, res.Delivery.PerSecond, res.Delivery.CompleteMessages, okPosts)
	fmt.Fprintf(w, "delivery latency  %s\n", res.Delivery.Latency)
	fmt.Fprintf(w, "last recipient    %s\n", res.Delivery.Fanout)
	fmt.Fprintf(w, "events     %s (own messages echoed %d, other %d, unparsable %d)\n", formatCounts(res.Events), selfEchoes, foreign, parseErrs)
	fmt.Fprintf(w, "resources  over %.1fs: %s\n", usage.Seconds, formatUsage(usage))

	if r.opt.jsonOut != "" {
		b, err := json.MarshalIndent(res, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(r.opt.jsonOut, append(b, '\n'), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

func suffix(prefix, v, end string) string {
	if v == "" {
		return ""
	}
	return prefix + v + end
}

func formatCounts(m map[string]int) string {
	if len(m) == 0 {
		return "none"
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf("%s %d", k, m[k])
	}
	return strings.Join(parts, ", ")
}

func formatUsage(u resourceResult) string {
	var parts []string
	if u.APICores != nil {
		parts = append(parts, fmt.Sprintf("API %.2f CPU cores", *u.APICores))
	}
	if u.APIPeakRSSMiB != nil {
		parts = append(parts, fmt.Sprintf("API peak RSS %.0f MiB", *u.APIPeakRSSMiB))
	}
	if u.PostgresCores != nil {
		parts = append(parts, fmt.Sprintf("all postgres processes %.2f cores", *u.PostgresCores))
	}
	if u.LoadGenCores != nil {
		parts = append(parts, fmt.Sprintf("load generator %.2f cores", *u.LoadGenCores))
	}
	if u.HostCPUPercent != nil {
		parts = append(parts, fmt.Sprintf("host CPU %.0f%% busy", *u.HostCPUPercent))
	}
	if len(parts) == 0 {
		return "not measured"
	}
	return strings.Join(parts, ", ")
}
