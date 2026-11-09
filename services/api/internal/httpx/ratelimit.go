package httpx

import (
	"net/netip"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter is an in-memory, keyed token-bucket rate limiter. State is per process, so
// each API replica limits on its own.
type Limiter struct {
	mu        sync.Mutex
	limit     rate.Limit
	burst     int
	buckets   map[string]*rate.Limiter
	lastSweep time.Time
}

const (
	// Past sweepThreshold keys, buckets that have fully refilled are dropped (they carry
	// no state worth keeping), at most once per sweepEvery so that a crowd of fresh keys
	// does not rescan the map on every request.
	sweepThreshold = 10_000
	sweepEvery     = time.Minute
	// maxBuckets bounds memory when keys rotate faster than buckets refill: some
	// buckets are forgotten, which only resets those keys' limits.
	maxBuckets = 100_000
)

// NewLimiter allows burst events immediately and then one event per interval.
func NewLimiter(interval time.Duration, burst int) *Limiter {
	return &Limiter{
		limit:   rate.Every(interval),
		burst:   burst,
		buckets: make(map[string]*rate.Limiter),
	}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		l.makeRoom(now)
		b = rate.NewLimiter(l.limit, l.burst)
		l.buckets[key] = b
	}
	return b.AllowN(now, 1)
}

func (l *Limiter) makeRoom(now time.Time) {
	if len(l.buckets) >= sweepThreshold && now.Sub(l.lastSweep) >= sweepEvery {
		l.lastSweep = now
		for k, b := range l.buckets {
			if b.TokensAt(now) >= float64(l.burst) {
				delete(l.buckets, k)
			}
		}
	}
	if len(l.buckets) >= maxBuckets {
		// Map iteration order is random, so this forgets an arbitrary tenth.
		drop := maxBuckets / 10
		for k := range l.buckets {
			if drop == 0 {
				break
			}
			delete(l.buckets, k)
			drop--
		}
	}
}

// RateKey is the key that limits requests from addr: the address itself for IPv4, and
// its /64 network for IPv6, where one subscriber typically holds a whole /64.
func RateKey(addr netip.Addr) string {
	if addr.Is6() && !addr.Is4In6() {
		p, err := addr.Prefix(64)
		if err == nil {
			return p.String()
		}
	}
	return addr.String()
}
