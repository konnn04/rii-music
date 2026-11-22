package server

import (
	"net/http"
	"strconv"
	"time"
)

// Listening streak: consecutive days with at least streakGoalMin minutes of
// music. Vani (the mascot) grows with the best streak ever reached, so a
// broken streak never takes a stage away.

const streakGoalMin = 10

// Mascot stages by best streak (days); index = stage.
var streakStages = []int{0, 3, 7, 14, 30, 60, 100}

type Streak struct {
	Current      int   `json:"current"`      // days, including today when today's goal is met
	Best         int   `json:"best"`         // longest run ever
	TodayMinutes int   `json:"todayMinutes"` // minutes listened today
	GoalMinutes  int   `json:"goalMinutes"`  // minutes that make a day count
	TodayDone    bool  `json:"todayDone"`    // today's goal reached
	AtRisk       bool  `json:"atRisk"`       // a streak is running but today isn't done yet
	TotalMinutes int   `json:"totalMinutes"` // all time
	Stage        int   `json:"stage"`        // 0 … len(streakStages)-1
	NextStageAt  int   `json:"nextStageAt"`  // best streak needed for the next stage (0 at the last one)
	Week         []int `json:"week"`         // minutes per day for the last 7 days, oldest first
}

func (s *Server) streakFor(uid string, tzMin int) (Streak, error) {
	loc := time.FixedZone("client", -tzMin*60)
	rows, err := s.db.Query(`SELECT started_at, played_ms FROM listen_events WHERE user_id = ?`, uid)
	if err != nil {
		return Streak{}, err
	}
	perDay := map[string]int64{} // local date → ms
	var total int64
	for rows.Next() {
		var at, ms int64
		if rows.Scan(&at, &ms) != nil {
			continue
		}
		perDay[time.UnixMilli(at).In(loc).Format("2006-01-02")] += ms
		total += ms
	}
	rows.Close()

	goal := int64(streakGoalMin) * 60_000
	met := func(d time.Time) bool { return perDay[d.Format("2006-01-02")] >= goal }
	now := time.Now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)

	st := Streak{GoalMinutes: streakGoalMin, TotalMinutes: int(total / 60_000), TodayMinutes: int(perDay[today.Format("2006-01-02")] / 60_000)}
	st.TodayDone = met(today)
	// Current: back from today (or from yesterday while today is still open).
	d := today
	if !st.TodayDone {
		d = today.AddDate(0, 0, -1)
	}
	for met(d) {
		st.Current++
		d = d.AddDate(0, 0, -1)
	}
	st.AtRisk = !st.TodayDone && st.Current > 0

	// Best: the longest run of met days.
	days := make([]time.Time, 0, len(perDay))
	for k, ms := range perDay {
		if ms < goal {
			continue
		}
		if t, err := time.ParseInLocation("2006-01-02", k, loc); err == nil {
			days = append(days, t)
		}
	}
	sortTimes(days)
	run := 0
	for i, t := range days {
		if i > 0 && days[i-1].AddDate(0, 0, 1).Equal(t) {
			run++
		} else {
			run = 1
		}
		st.Best = max(st.Best, run)
	}
	st.Best = max(st.Best, st.Current)

	for i, need := range streakStages {
		if st.Best >= need {
			st.Stage = i
		}
	}
	if st.Stage+1 < len(streakStages) {
		st.NextStageAt = streakStages[st.Stage+1]
	}
	for i := 6; i >= 0; i-- {
		st.Week = append(st.Week, int(perDay[today.AddDate(0, 0, -i).Format("2006-01-02")]/60_000))
	}
	return st, nil
}

func sortTimes(ts []time.Time) {
	for i := 1; i < len(ts); i++ {
		for j := i; j > 0 && ts[j].Before(ts[j-1]); j-- {
			ts[j], ts[j-1] = ts[j-1], ts[j]
		}
	}
}

// GET /api/streak?tz=<getTimezoneOffset()>
func (s *Server) handleStreak(w http.ResponseWriter, r *http.Request) {
	tzMin, _ := strconv.Atoi(r.URL.Query().Get("tz"))
	st, err := s.streakFor(userOf(r).ID, tzMin)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}
