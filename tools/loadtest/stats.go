package main

import (
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// summary describes a set of latency samples in milliseconds.
type summary struct {
	Count int     `json:"count"`
	P50   float64 `json:"p50_ms"`
	P95   float64 `json:"p95_ms"`
	P99   float64 `json:"p99_ms"`
	Max   float64 `json:"max_ms"`
	Mean  float64 `json:"mean_ms"`
}

// summarize sorts samples (nanoseconds) in place and returns nearest-rank percentiles.
func summarize(samples []int64) summary {
	if len(samples) == 0 {
		return summary{}
	}
	slices.Sort(samples)
	var total float64
	for _, s := range samples {
		total += float64(s)
	}
	ms := func(ns int64) float64 { return float64(ns) / 1e6 }
	return summary{
		Count: len(samples),
		P50:   ms(percentile(samples, 50)),
		P95:   ms(percentile(samples, 95)),
		P99:   ms(percentile(samples, 99)),
		Max:   ms(samples[len(samples)-1]),
		Mean:  total / float64(len(samples)) / 1e6,
	}
}

// percentile returns the nearest-rank percentile p (0–100] of sorted samples.
func percentile(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(p/100*float64(len(sorted))+0.999999999) - 1
	rank = max(0, min(rank, len(sorted)-1))
	return sorted[rank]
}

func (s summary) String() string {
	if s.Count == 0 {
		return "no samples"
	}
	return fmt.Sprintf("p50 %.1f ms  p95 %.1f ms  p99 %.1f ms  max %.1f ms  (mean %.1f ms, n=%d)", s.P50, s.P95, s.P99, s.Max, s.Mean, s.Count)
}

// Linux process accounting from /proc, for the resources used during the measured window.
// USER_HZ is 100 on every mainstream Linux build; the standard library cannot ask sysconf.
const clockTicks = 100

// cpuTicks returns utime+stime of a process, or of every process named comm when pid is 0.
func cpuTicks(pid int, comm string) (uint64, bool) {
	read := func(path string) (uint64, string, bool) {
		b, err := os.ReadFile(path)
		if err != nil {
			return 0, "", false
		}
		s := string(b)
		open, end := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
		if open < 0 || end < open {
			return 0, "", false
		}
		fields := strings.Fields(s[end+1:])
		// After the command name: state is field 3, utime 14 and stime 15 (1-based).
		if len(fields) < 13 {
			return 0, "", false
		}
		u, err1 := strconv.ParseUint(fields[11], 10, 64)
		st, err2 := strconv.ParseUint(fields[12], 10, 64)
		if err1 != nil || err2 != nil {
			return 0, "", false
		}
		return u + st, s[open+1 : end], true
	}
	if pid > 0 {
		t, _, ok := read(fmt.Sprintf("/proc/%d/stat", pid))
		return t, ok
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false
	}
	var total uint64
	found := false
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		if t, name, ok := read("/proc/" + e.Name() + "/stat"); ok && name == comm {
			total += t
			found = true
		}
	}
	return total, found
}

// peakRSS returns VmHWM of a process in MiB.
func peakRSS(pid int) (float64, bool) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			f := strings.Fields(rest)
			if len(f) >= 1 {
				kb, err := strconv.ParseFloat(f[0], 64)
				return kb / 1024, err == nil
			}
		}
	}
	return 0, false
}

// hostCPU returns busy and total jiffies of all CPUs from /proc/stat.
func hostCPU() (busy, total uint64, ok bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	line, _, _ := strings.Cut(string(b), "\n")
	f := strings.Fields(line)
	if len(f) < 8 || f[0] != "cpu" {
		return 0, 0, false
	}
	var idle uint64
	for i, v := range f[1:] {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		// guest and guest_nice (fields 9, 10) are already counted in user and nice.
		if i >= 8 {
			break
		}
		total += n
		if i == 3 || i == 4 { // idle, iowait
			idle += n
		}
	}
	return total - idle, total, true
}

// resources samples CPU use between start and stop.
type resources struct {
	apiPID                      int
	apiStart, pgStart           uint64
	selfStart                   uint64
	busyStart, totalStart       uint64
	apiOK, pgOK, selfOK, hostOK bool
	began                       time.Time
}

type resourceResult struct {
	Seconds        float64  `json:"seconds"`
	APICores       *float64 `json:"api_cpu_cores,omitempty"`
	APIPeakRSSMiB  *float64 `json:"api_peak_rss_mib,omitempty"`
	PostgresCores  *float64 `json:"postgres_cpu_cores,omitempty"`
	LoadGenCores   *float64 `json:"loadgen_cpu_cores,omitempty"`
	HostCPUPercent *float64 `json:"host_cpu_percent,omitempty"`
}

func startResources(apiPID int) *resources {
	r := &resources{apiPID: apiPID, began: time.Now()}
	if apiPID > 0 {
		r.apiStart, r.apiOK = cpuTicks(apiPID, "")
	}
	r.pgStart, r.pgOK = cpuTicks(0, "postgres")
	r.selfStart, r.selfOK = cpuTicks(os.Getpid(), "")
	r.busyStart, r.totalStart, r.hostOK = hostCPU()
	return r
}

func (r *resources) stop() resourceResult {
	secs := time.Since(r.began).Seconds()
	out := resourceResult{Seconds: secs}
	cores := func(start uint64, now uint64) *float64 {
		v := float64(now-start) / clockTicks / secs
		return &v
	}
	if r.apiOK {
		if t, ok := cpuTicks(r.apiPID, ""); ok && t >= r.apiStart {
			out.APICores = cores(r.apiStart, t)
		}
		if mib, ok := peakRSS(r.apiPID); ok {
			out.APIPeakRSSMiB = &mib
		}
	}
	if r.pgOK {
		if t, ok := cpuTicks(0, "postgres"); ok && t >= r.pgStart {
			out.PostgresCores = cores(r.pgStart, t)
		}
	}
	if r.selfOK {
		if t, ok := cpuTicks(os.Getpid(), ""); ok && t >= r.selfStart {
			out.LoadGenCores = cores(r.selfStart, t)
		}
	}
	if r.hostOK {
		if busy, total, ok := hostCPU(); ok && total > r.totalStart {
			v := 100 * float64(busy-r.busyStart) / float64(total-r.totalStart)
			out.HostCPUPercent = &v
		}
	}
	return out
}
