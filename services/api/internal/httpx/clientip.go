package httpx

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type clientIPKey struct{}

// IPResolver determines the client address, honouring X-Forwarded-For only when the
// direct peer is a trusted proxy. Untrusted peers cannot spoof their address.
type IPResolver struct {
	trusted []netip.Prefix
}

func NewIPResolver(trusted []netip.Prefix) *IPResolver {
	return &IPResolver{trusted: trusted}
}

func (res *IPResolver) Resolve(r *http.Request) netip.Addr {
	remote := parseRemoteAddr(r.RemoteAddr)
	if !res.isTrusted(remote) {
		return remote
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	// Walk from the closest hop outwards and return the first untrusted address.
	for i := len(hops) - 1; i >= 0; i-- {
		addr, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return remote
		}
		addr = addr.Unmap()
		if !res.isTrusted(addr) {
			return addr
		}
	}
	return remote
}

func (res *IPResolver) isTrusted(addr netip.Addr) bool {
	for _, p := range res.trusted {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Middleware stores the resolved client address in the request context.
func (res *IPResolver) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), clientIPKey{}, res.Resolve(r))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ClientIP returns the address stored by IPResolver.Middleware, or the zero Addr.
func ClientIP(ctx context.Context) netip.Addr {
	addr, _ := ctx.Value(clientIPKey{}).(netip.Addr)
	return addr
}

// IPString returns the address as text for an inet column, or nil when unknown.
func IPString(addr netip.Addr) *string {
	if !addr.IsValid() {
		return nil
	}
	s := addr.String()
	return &s
}

func parseRemoteAddr(remote string) netip.Addr {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return addr.Unmap()
}
