// Command loadtest drives a FUDISLTE API for load tests and restore drills. It uses only
// the Go standard library and talks to the API over HTTP like the web app does.
//
//	loadtest setup-code -base URL -email EMAIL                 first-run setup, step 1
//	loadtest setup      -base URL -email EMAIL -out FILE       first-run setup, step 2
//	loadtest seed-sql   -org ID -users N -sql FILE -tokens FILE
//	loadtest populate   -base URL -org ID -tokens FILE         realistic content (drills)
//	loadtest run        -base URL -tokens FILE -users N ...    the load test itself
//
// Secrets never appear on the command line: the setup token and the emailed code are read
// from FUDISLTE_LOADTEST_SETUP_TOKEN and FUDISLTE_LOADTEST_SETUP_CODE, and session tokens are
// only written to files created with mode 0600 ("accounts files": one line per account,
// "<user-id> TAB <email> TAB <session-token>").
package main

import (
	"fmt"
	"os"
)

const usage = `usage: loadtest <command> [flags]

commands:
  setup-code  request the first-run setup code (POST /api/v1/setup/code)
  setup       complete first-run setup (POST /api/v1/setup) and save the owner's session
  seed-sql    write SQL that creates users, memberships and sessions, plus their tokens
  populate    create channels, messages, threads, reactions, files and DMs through the API
  run         open live event streams, post messages and measure latency and delivery

Run "loadtest <command> -h" for the flags of a command.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "setup-code":
		err = cmdSetupCode(args)
	case "setup":
		err = cmdSetup(args)
	case "seed-sql":
		err = cmdSeedSQL(args)
	case "populate":
		err = cmdPopulate(args)
	case "run":
		err = cmdRun(args)
	case "-h", "-help", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadtest:", err)
		os.Exit(1)
	}
}
