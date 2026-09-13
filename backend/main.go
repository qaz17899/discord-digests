package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.Ltime)
	if len(os.Args) < 2 {
		usage()
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "channels":
		cmdChannels(args)
	case "watch":
		cmdWatch(args)
	case "backfill":
		cmdBackfill(args)
	case "digest":
		cmdDigest(args)
	case "refresh":
		cmdRefresh(args)
	case "serve":
		cmdServe(args)
	case "rotate":
		cmdRotate(args)
	case "status":
		cmdStatus(args)
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
	}
}

func usage() {
	fmt.Print(`discordwatch — Discord message monitor

  channels                 list guilds and channels (marks the watched ones)
  channels -add <id>       add a channel to the watch list
  channels -remove <id>    remove a channel from the watch list

  watch                    stay connected and collect in real time
  backfill <id>[,<id>…] <from> <to>   pull history over REST (max 30 days)
  backfill -all <from> <to>           every channel in the watch list
  backfill -queued                    run whatever the dashboard queued
  backfill -list                      show recent history fetches
  digest <id> [from] [to]  compress a range and write a report
  refresh [from] [to]      re-sign expired attachment links (needs a bot token)
  serve [-addr host:port]  read-only API for the workbench frontend
  rotate                   compress finished files into archive/
  status                   show what has been collected

Times accept YYYY-MM-DD or YYYY-MM-DDTHH:MM (GMT+8). DM_HOME sets the data root.
`)
	os.Exit(2)
}

// --- channels ---

func cmdChannels(args []string) {
	fs := flag.NewFlagSet("channels", flag.ExitOnError)
	add := fs.String("add", "", "channel id to add to the watch list")
	remove := fs.String("remove", "", "channel id to remove from the watch list")
	fs.Parse(args)

	cfg := loadConfig()
	switch {
	case *add != "":
		if !cfg.watching(*add) {
			cfg.Settings.Watch = append(cfg.Settings.Watch, *add)
			cfg.SaveSettings()
		}
		fmt.Printf("watching %s\n", *add)
		return
	case *remove != "":
		kept := cfg.Settings.Watch[:0]
		for _, id := range cfg.Settings.Watch {
			if id != *remove {
				kept = append(kept, id)
			}
		}
		cfg.Settings.Watch = kept
		cfg.SaveSettings()
		fmt.Printf("no longer watching %s\n", *remove)
		return
	}

	client := NewClient(cfg.UserToken, cfg.BotToken)
	me, err := client.Me()
	if err != nil {
		fatal("identify: %v", err)
	}
	fmt.Printf("account: %s (%s)\n\n", me.Username, me.ID)

	guilds, err := client.Guilds()
	if err != nil {
		fatal("list guilds: %v", err)
	}
	sort.Slice(guilds, func(i, j int) bool { return guilds[i].Name < guilds[j].Name })

	total := 0
	for _, g := range guilds {
		chans, err := client.GuildChannels(g.ID)
		if err != nil {
			fmt.Printf("%s (%s)\n  ! %v\n", g.Name, g.ID, err)
			continue
		}
		sort.Slice(chans, func(i, j int) bool { return chans[i].Type < chans[j].Type || chans[i].Name < chans[j].Name })
		fmt.Printf("%s  (%s)\n", g.Name, g.ID)
		for _, ch := range chans {
			kind := channelKind(ch.Type)
			if kind == "category" {
				continue
			}
			mark := " "
			if cfg.watching(ch.ID) {
				mark = "*"
			}
			fmt.Printf("  %s [%-6s] %-28s %s\n", mark, kind, truncate(ch.Name, 28), ch.ID)
			total++
		}
	}
	fmt.Printf("\n%d channels; * = watched (%d)\n", total, len(cfg.Settings.Watch))
	fmt.Println("add with: discordwatch channels -add <channelId>")
}

// --- watch ---

func cmdWatch(args []string) {
	fs := flag.NewFlagSet("watch", flag.ExitOnError)
	noGap := fs.Bool("no-gap-fill", false, "skip the REST catch-up on startup")
	debug := fs.Bool("debug", false, "log every gateway dispatch event name")
	fs.Parse(args)
	debugEvents = *debug

	cfg := loadConfig()
	if len(cfg.Settings.Watch) == 0 {
		fatal("watch list is empty — run `discordwatch channels`, then `discordwatch channels -add <id>`")
	}
	store := NewStore(cfg.Home)
	client := NewClient(cfg.UserToken, cfg.BotToken)

	// Close the hole left by the last shutdown before going live, so nothing is
	// missing between the previous session and this one.
	if !*noGap {
		for _, ch := range cfg.Settings.Watch {
			n, err := GapFill(client, store, ch, time.Now())
			if err != nil {
				log.Printf("gap fill %s: %v", ch, err)
				continue
			}
			if n > 0 {
				log.Printf("gap fill %s: +%d", ch, n)
			}
		}
	}
	if n := ResumeBackfillJobs(cfg.Home); n > 0 {
		log.Printf("resuming %d backfill job(s)", n)
	}
	if n, err := store.Rotate(); err != nil {
		log.Printf("rotate: %v", err)
	} else if n > 0 {
		log.Printf("rotated %d file(s)", n)
	}

	collector := NewCollector(cfg, store, client)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("shutting down; flushing state")
		collector.FlushStates()
		os.Remove(heartbeatFile(cfg.Home))
		store.Close()
		os.Exit(0)
	}()

	log.Printf("watching %d channel(s); data root %s", len(cfg.Settings.Watch), cfg.Home)
	collector.Run()
}

// --- backfill ---

// cmdBackfill queues a history fetch. If the collector is running it picks the job
// up within seconds; if it is not, this process does the work itself — which is
// only safe because nothing else writes message files at that moment.
func cmdBackfill(args []string) {
	fs := flag.NewFlagSet("backfill", flag.ExitOnError)
	all := fs.Bool("all", false, "every channel in the watch list")
	list := fs.Bool("list", false, "show recent history fetches")
	queued := fs.Bool("queued", false, "run whatever is already queued, then exit")
	fs.Parse(args)
	rest := fs.Args()

	cfg := loadConfig()
	store := NewStore(cfg.Home)

	if *list {
		jobs := listJobs(cfg.Home, 20)
		if len(jobs) == 0 {
			fmt.Println("no history fetches yet")
			return
		}
		for _, j := range jobs {
			fmt.Printf("%-22s %-9s %s → %s  %d/%d day(s)  added %-6d updated %-6d  %s\n",
				j.ID, j.State, j.From, j.To, j.Totals.Done, j.Totals.Units, j.Totals.Added, j.Totals.Updated, j.Message)
		}
		return
	}

	client := NewClient(cfg.UserToken, cfg.BotToken)
	if hb, online := ReadHeartbeat(cfg.Home); online && *queued {
		fatal("the collector (pid %d) is running and owns the queue; watch its log instead", hb.PID)
	}
	if *queued {
		id, err := RunBackfillJobs(cfg.Home, store, client, stateNotifier(store), true)
		if err != nil {
			fatal("%v", err)
		}
		if id == "" {
			fmt.Println("the queue is empty")
			return
		}
		if j, ok := findJob(cfg.Home, id); ok {
			fmt.Printf("%s: %s\n", id, j.Message)
		}
		return
	}

	if len(rest) < 3 {
		fatal("usage: backfill <channelId>[,<channelId>...] <from> <to>   (or -all / -queued / -list)")
	}
	channels := strings.Split(rest[0], ",")
	if *all {
		channels = cfg.Settings.Watch
	}
	from, err := parseWhen(rest[1])
	if err != nil {
		fatal("%v", err)
	}
	to, err := parseWhen(rest[2])
	if err != nil {
		fatal("%v", err)
	}
	// A bare date means "through the end of that day".
	if len(rest[2]) == len(dayLayout) {
		to = to.Add(24*time.Hour - time.Second)
	}

	job, err := CreateBackfillJob(cfg.Home, channels, from, to)
	if err != nil {
		fatal("%v", err)
	}
	log.Printf("queued %s: %s → %s, %d unit(s)", job.ID, job.From, job.To, job.Totals.Units)

	if hb, online := ReadHeartbeat(cfg.Home); online {
		fmt.Printf("the collector (pid %d) will take it within a few seconds; check the dashboard\n", hb.PID)
		return
	}
	fmt.Println("the collector is not running; fetching here")
	id, err := RunBackfillJobs(cfg.Home, store, client, stateNotifier(store), true)
	if err != nil {
		fatal("%v", err)
	}
	if j, ok := findJob(cfg.Home, id); ok {
		fmt.Println(j.Message)
	}
}

// --- digest ---

func cmdDigest(args []string) {
	fs := flag.NewFlagSet("digest", flag.ExitOnError)
	maxChars := fs.Int("max-chars", 0, "override the per-batch character budget")
	fs.Parse(args)
	rest := fs.Args()
	if len(rest) < 1 {
		fatal("usage: digest <channelId> [from] [to]")
	}

	now := time.Now().In(gmt8)
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, gmt8)
	to := now
	if len(rest) > 1 {
		t, err := parseWhen(rest[1])
		if err != nil {
			fatal("%v", err)
		}
		from = t
	}
	if len(rest) > 2 {
		t, err := parseWhen(rest[2])
		if err != nil {
			fatal("%v", err)
		}
		// A bare date means "through the end of that day".
		if len(rest[2]) == len(dayLayout) {
			t = t.Add(24*time.Hour - time.Second)
		}
		to = t
	}

	cfg := loadConfig()
	if *maxChars > 0 {
		cfg.Settings.LLM.MaxChars = *maxChars
	}
	store := NewStore(cfg.Home)

	llm := NewLLMClient(cfg.Settings.LLM)
	if llm == nil {
		log.Printf("no llm configured; writing the compressed input only")
	}
	res, err := Digest(llm, store, cfg, rest[0], from, to, nil)
	if err != nil {
		fatal("%v", err)
	}
	log.Printf("%d message(s), %d batch(es)", res.Messages, res.Batches)
	log.Printf("input:  %s", res.Input)
	if res.Report != "" {
		log.Printf("report: %s", res.Report)
	} else {
		log.Printf("feed the input file to a model, or set llm.baseUrl/apiKey/model in config.json")
	}
}

// --- refresh ---

func cmdRefresh(args []string) {
	fs := flag.NewFlagSet("refresh", flag.ExitOnError)
	dry := fs.Bool("dry-run", false, "only report how many links are stale")
	fs.Parse(args)
	rest := fs.Args()

	from, to := "", ""
	if len(rest) > 0 {
		t, err := parseWhen(rest[0])
		if err != nil {
			fatal("%v", err)
		}
		from = t.In(gmt8).Format(dayLayout)
	}
	if len(rest) > 1 {
		t, err := parseWhen(rest[1])
		if err != nil {
			fatal("%v", err)
		}
		to = t.In(gmt8).Format(dayLayout)
	}

	cfg := loadConfig()
	store := NewStore(cfg.Home)
	if err := RefreshAll(NewClient(cfg.UserToken, cfg.BotToken), store, cfg.Home, from, to, *dry); err != nil {
		fatal("%v", err)
	}
}

// --- serve ---

func cmdServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8787", "listen address")
	fs.Parse(args)

	cfg := loadConfig()
	store := NewStore(cfg.Home)
	if err := Serve(cfg, store, NewClient(cfg.UserToken, cfg.BotToken), *addr); err != nil {
		fatal("%v", err)
	}
}

// --- rotate ---

func cmdRotate(args []string) {
	cfg := loadConfig()
	store := NewStore(cfg.Home)
	n, err := store.Rotate()
	if err != nil {
		fatal("%v", err)
	}
	fmt.Printf("rotated %d file(s)\n", n)
}

// --- status ---

func cmdStatus(args []string) {
	cfg := loadConfig()
	store := NewStore(cfg.Home)
	channels, err := store.Channels()
	if err != nil {
		fatal("%v", err)
	}
	if len(channels) == 0 {
		fmt.Println("no data yet — run `discordwatch watch`")
		return
	}

	fmt.Printf("data root: %s\n\n", cfg.Home)
	var totalMsgs int
	var totalBytes int64
	for _, ch := range channels {
		st := store.State(ch)
		size := dirSize(store.channelDir(ch))
		totalBytes += size
		totalMsgs += st.TotalFetched
		watched := ""
		if cfg.watching(ch) {
			watched = "*"
		}
		name := st.ChannelName
		if name == "" {
			name = "(unknown)"
		}
		fmt.Printf("%s %-24s %-8s msgs=%-7d last=%s  %s\n",
			watched, truncate(name, 24), st.ChannelType, st.TotalFetched,
			orDash(st.LastTS), humanBytes(size))
		fmt.Printf("   %s\n", ch)
	}
	fmt.Printf("\n%d channel(s), %d message(s), %s on disk\n", len(channels), totalMsgs, humanBytes(totalBytes))
	fmt.Println("* = in the watch list")
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "KMGTPE"[exp])
}
