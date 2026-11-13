/* Lions Den: a static site that reads Central Districts Lions games
   straight from the BasketballConnect (Squadi) live-scores API. */
(function () {
  'use strict';

  const CFG = window.LIONS_CONFIG;
  // An older cached config.js has one competition at the top level.
  if (!CFG.competitions) CFG.competitions = [{ id: CFG.competitionId, label: 'Juniors', teamIds: CFG.teamIds, sourceUrl: CFG.sourceUrl }];
  const app = document.getElementById('app');
  const TZ = CFG.timeZone;
  const STORE_MY_TEAM = 'lions.myTeam';

  let DATA = null;        // { games, teams, rounds, fetchedAt }
  let refreshTimer = null;
  const ui = { age: 'All', sex: 'All', round: null };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  const fmt = (opts) => new Intl.DateTimeFormat('en-AU', Object.assign({ timeZone: TZ }, opts));
  const fDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
  const fWeekday = fmt({ weekday: 'short' });
  const fLongDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
  const fTime = fmt({ hour: 'numeric', minute: '2-digit', hour12: true });
  const fKey = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = (d) => fTime.format(d).replace(/\s/g, '').toLowerCase();
  const dayKey = (d) => { const p = {}; fKey.formatToParts(d).forEach((x) => { p[x.type] = x.value; }); return p.year + '-' + p.month + '-' + p.day; };
  const todayKey = () => dayKey(new Date());
  const tomorrowKey = () => dayKey(new Date(Date.now() + 864e5));
  const dayLabel = (d) => {
    const k = dayKey(d);
    if (k === todayKey()) return 'Today';
    if (k === tomorrowKey()) return 'Tomorrow';
    return fDay.format(d);
  };
  const whenShort = (d) => (dayKey(d) === todayKey() ? 'Today ' : fWeekday.format(d) + ' ') + time(d);
  const isLions = (name) => !!name && name.indexOf(CFG.clubMatch) !== -1;

  function parseTeam(t) {
    if (!t || !t.name || /^bye$/i.test(t.name.trim())) return null;
    const nm = t.name.trim();
    // "U16B ..." juniors, "U21M ..." / "U23W ..." YDL, "SM ..." / "SW ..." seniors and "RM ..." / "RW ..." reserves.
    const m = nm.match(/^(U\d+|S|R)([BGMW])\s+(.*)$/);
    const rest = (m ? m[3] : nm).trim();
    const lions = isLions(t.name);
    const num = lions ? (rest.match(/(\d+)\s*$/) || [])[1] : null;
    return {
      id: t.id,
      name: nm,
      age: m ? (m[1] === 'S' ? 'Senior' : m[1] === 'R' ? 'Reserves' : m[1]) : '',
      tile: m ? (m[1] === 'S' ? 'SNR' : m[1] === 'R' ? 'RES' : m[1]) : '',
      sex: m ? { B: 'Boys', G: 'Girls', M: 'Men', W: 'Women' }[m[2]] : '',
      gender: m ? (/[BM]/.test(m[2]) ? 'Boys' : 'Girls') : '', // filter key: male or female
      club: rest,
      short: lions ? 'Lions' + (num ? ' ' + num : '') : rest,
      logo: lions ? 'shield.png?v=2' : (/^https:\/\//.test(t.logoUrl || '') ? t.logoUrl : ''),
      lions
    };
  }

  // Club logo from BasketballConnect (our own shield for the Lions). Falls back to a blank tile.
  function logo(t, size) {
    size = size || 28;
    const box = 'width:' + size + 'px;height:' + size + 'px';
    if (!t || !t.logo) return '<span class="logo blank" style="' + box + '" aria-hidden="true"></span>';
    return '<img class="logo" src="' + esc(t.logo) + '" alt="" width="' + size + '" height="' + size + '" style="' + box + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'logo blank\',style:\'' + box + '\'}))">';
  }

  function shortDivision(name) {
    if (!name) return '';
    const parts = name.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && /^(U\d+|Senior)\b/.test(parts[0])) parts.shift();
    return parts.filter((p) => !/^grading season$/i.test(p)).map((p) => p.replace(/^Division /, 'Div ')).join(' · ');
  }

  function normalise(sets) {
    const games = [];
    sets.forEach(({ comp, json }) => (json.rounds || []).forEach((rd) => {
      (rd.matches || []).forEach((m) => {
        const t1 = parseTeam(m.team1), t2 = parseTeam(m.team2);
        [t1, t2].forEach((t) => { if (t) t.comp = comp; });
        if (!((t1 && t1.lions) || (t2 && t2.lions))) return;
        const st = (m.matchStatus || '').toUpperCase();
        const vc = m.venueCourt || {}, v = vc.venue || {};
        games.push({
          id: m.id,
          round: rd.name || ('Round ' + ((rd.sequence || 0) + 1)),
          roundSeq: rd.sequence != null ? rd.sequence : 0,
          division: (rd.division && rd.division.name) || '',
          divisionShort: [comp.label === 'Juniors' ? '' : comp.label, shortDivision(rd.division && rd.division.name)].filter(Boolean).join(' · '),
          start: new Date(m.startTime),
          comp,
          postponed: /POSTPONED|CANCEL|ABANDON/.test(st),
          status: st === 'ENDED' ? 'final' : (st && !/POSTPONED|CANCEL|ABANDON/.test(st) ? 'live' : 'upcoming'),
          t1, t2,
          s1: m.team1Score, s2: m.team2Score,
          r1: m.team1ResultId, r2: m.team2ResultId,
          bye: !t1 || !t2,
          venue: v.name || '',
          venueShort: v.shortName || v.name || '',
          court: vc.name || '',
          lat: vc.lat || v.lat, lng: vc.lng || v.lng,
          finals: !!m.isFinals, finalsAlias: m.finalsAlias || ''
        });
      });
    }));
    games.sort((a, b) => a.start - b.start);

    const teams = new Map();
    games.forEach((g) => [g.t1, g.t2].forEach((t) => {
      if (t && t.lions && !teams.has(t.id)) teams.set(t.id, t);
    }));

    const roundMap = new Map();
    games.forEach((g) => { if (!roundMap.has(g.roundSeq)) roundMap.set(g.roundSeq, { seq: g.roundSeq, name: g.round, games: [] }); roundMap.get(g.roundSeq).games.push(g); });
    const rounds = Array.from(roundMap.values()).sort((a, b) => a.seq - b.seq);
    rounds.forEach((r) => {
      r.first = r.games[0].start; r.last = r.games[r.games.length - 1].start;
      r.finals = r.games.filter((g) => g.status === 'final').length;
    });
    return { games, teams, rounds, fetchedAt: new Date() };
  }

  /* The game seen from one Lions team's side. */
  function view(g, teamId) {
    let us = g.t1, them = g.t2, su = g.s1, sth = g.s2, home = true;
    if (teamId != null ? (g.t2 && g.t2.id === teamId) : (!(g.t1 && g.t1.lions) && g.t2 && g.t2.lions)) {
      us = g.t2; them = g.t1; su = g.s2; sth = g.s1; home = false;
    }
    if (!us) { us = them; them = null; }
    let res = null;
    if (g.bye) res = 'BYE';
    else if (g.status === 'final') {
      if (them && them.lions) res = 'CD';
      else if ((su || 0) === 0 && (sth || 0) === 0) res = 'NR';
      else res = su > sth ? 'W' : su < sth ? 'L' : 'D';
    } else if (g.status === 'live') res = 'LIVE';
    return { g, us, them, su, sth, home, res };
  }

  const groupName = (t) => (t.age + ' ' + t.sex).trim();
  const ageNum = (a) => (a === 'Senior' ? 90 : a === 'Reserves' ? 91 : parseInt(String(a).replace(/\D/g, ''), 10) || 0);
  const teamSort = (a, b) => ageNum(a.age) - ageNum(b.age) || a.gender.localeCompare(b.gender) || a.short.localeCompare(b.short, undefined, { numeric: true });

  const BADGE_TEXT = { W: 'W', L: 'L', D: 'D', CD: 'CD', NR: 'N/R', BYE: 'BYE', LIVE: 'LIVE' };
  const BADGE_LABEL = { W: 'Win', L: 'Loss', D: 'Draw', CD: 'Club derby', NR: 'No result', BYE: 'Bye', LIVE: 'Live' };
  const badge = (res, sm) => res ? '<span class="badge ' + res + (sm ? ' sm' : '') + '" title="' + BADGE_LABEL[res] + '" aria-label="' + BADGE_LABEL[res] + '">' + BADGE_TEXT[res] + '</span>' : '';
  const mapsUrl = (g) => g.lat && g.lng
    ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(g.lat + ',' + g.lng)
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(g.venue);
  const pin = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"></path><circle cx="12" cy="9.5" r="2.5"></circle></svg>';
  const starIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.3l-6.2 3.6 1.6-7-5.4-4.7 7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7z"></path></svg>';

  function opponentText(v) {
    if (!v.them) return 'Bye';
    return (v.home ? 'v ' : '@ ') + v.them.short;
  }

  /* One game row, from the side of `teamId` (or the Lions side). */
  function gameRow(g, opts) {
    opts = opts || {};
    const v = view(g, opts.teamId);
    const title = opts.showAge ? groupName(v.us) + ' ' + v.us.short : v.us.short;
    const sub = [];
    if (opts.showRound) sub.push(g.round);
    if (opts.showDivision !== false && g.divisionShort) sub.push(g.divisionShort);
    if (!g.bye) sub.push(g.venueShort + (g.court ? ' ' + g.court.replace('Court ', 'Ct ') : ''));
    if (g.status !== 'upcoming' || opts.showDate) sub.push(g.status === 'upcoming' ? fDay.format(g.start) : whenShort(g.start));
    let right = '';
    if (g.bye) right = badge('BYE');
    else if (g.postponed) right = '<span class="when">Postponed</span>';
    else if (g.status === 'upcoming') right = '<span class="when">' + esc(opts.showDate ? time(g.start) : dayLabel(g.start) + '<br>' + time(g.start)).replace('&lt;br&gt;', '<br>') + '</span>';
    else right = '<span class="score">' + esc(v.su) + '–' + esc(v.sth) + '</span>' + badge(v.res);
    const href = (!g.bye && g.status !== 'upcoming') ? '#/game/' + g.id : '#/team/' + v.us.id;
    const tag = opts.link === false ? 'div' : 'a';
    return '<' + tag + ' class="row"' + (tag === 'a' ? ' href="' + href + '"' : '') + '>' +
      (g.bye ? '' : logo(v.them, 30)) + '<div class="row-main"><span class="row-title">' + esc(title) + ' <span class="vs">' + esc(opponentText(v)) + '</span></span>' +
      '<span class="row-sub">' + esc(sub.join(' · ')) + '</span></div>' + right + '</' + tag + '>';
  }

  function liveCard(g) {
    const v = view(g);
    return '<a class="live-card" href="#/game/' + g.id + '">' +
      '<div class="live-top"><span class="live-dot"></span><span class="label">LIVE</span><span class="div">' + esc(g.divisionShort) + '</span></div>' +
      '<div class="live-lines"><span class="t1">' + logo(v.us, 26) + esc(groupName(v.us) + ' ' + v.us.short) + '</span><span class="s1">' + esc(v.su ?? 0) + '</span>' +
      '<span class="t2">' + logo(v.them, 26) + esc(v.them ? v.them.short : '') + '</span><span class="s2">' + esc(v.sth ?? 0) + '</span></div>' +
      '<span class="live-foot">' + esc(g.venueShort + ' · ' + g.court) + ' · tap for the box score</span></a>';
  }

  function myTeamIds() { return String(store.get(STORE_MY_TEAM) || '').split(',').map((v) => parseInt(v, 10)).filter((v) => !isNaN(v)); }
  function isMyTeam(id) { return myTeamIds().includes(id); }
  function teamGames(id) { return DATA.games.filter((g) => (g.t1 && g.t1.id === id) || (g.t2 && g.t2.id === id)); }

  /* ---------- pages ---------- */
  function filterMatch(t) { return !!t && t.lions && (ui.age === 'All' || t.age === ui.age) && (ui.sex === 'All' || t.gender === ui.sex); }
  function gameMatches(g) { return filterMatch(g.t1) || filterMatch(g.t2); }

  function pageHome() {
    const now = Date.now();
    const ages = Array.from(new Set(Array.from(DATA.teams.values()).map((t) => t.age))).sort((a, b) => ageNum(a) - ageNum(b));
    const games = DATA.games.filter(gameMatches);
    const live = games.filter((g) => g.status === 'live');
    const horizon = now + 8 * 864e5;
    const upcoming = games.filter((g) => g.status === 'upcoming' && !g.bye && !g.postponed && g.start.getTime() > now - 3 * 3600e3 && g.start.getTime() < horizon);
    const recent = games.filter((g) => g.status === 'final' && !g.bye && g.start.getTime() > now - 2 * 864e5).reverse();
    let html = '';

    const mine = myTeamIds().filter((id) => DATA.teams.has(id)).map((id) => DATA.teams.get(id)).sort(teamSort);
    if (mine.length) {
      html += '<section><h2 class="section-title">' + (mine.length > 1 ? 'My teams' : 'My team') + '</h2><div class="grid">' + mine.map((t) => {
        const tg = teamGames(t.id);
        const next = tg.find((g) => g.status !== 'final' && !g.postponed);
        const last = tg.filter((g) => g.status === 'final').pop();
        return '<div class="card mine"><div class="card-head"><h3>' + esc(groupName(t) + ' ' + t.short) + '</h3><a class="meta" href="#/team/' + t.id + '">Team page</a></div>' +
          (next ? gameRow(next, { teamId: t.id, showDivision: false }) : '<div class="empty">No more games scheduled.</div>') +
          (last ? gameRow(last, { teamId: t.id, showDivision: false }) : '') + '</div>';
      }).join('') + '</div></section>';
    }

    html += '<div class="page-head"><div><div class="eyebrow">' + esc(fLongDay.format(new Date())) + '</div><h1 class="page-title">Game day</h1>' +
      '<div class="page-sub">' + (live.length ? live.length + ' live · ' : '') + upcoming.length + (upcoming.length === 1 ? ' Lions game' : ' Lions games') + ' in the next week</div></div></div>' + filterChips(ages);

    if (live.length) html += '<section><h2 class="section-title">Live now</h2><div class="live-grid">' + live.map(liveCard).join('') + '</div></section>';

    if (recent.length) {
      html += '<section><h2 class="section-title">Just finished</h2><div class="card">' + recent.slice(0, 8).map((g) => gameRow(g, { showAge: true })).join('') + '</div>' +
        (recent.length > 8 ? '<p><a href="#/results">See all results</a></p>' : '') + '</section>';
    }

    if (!upcoming.length) {
      html += '<div class="notice"><h2>No ' + (ui.age === 'All' && ui.sex === 'All' ? 'Lions' : 'matching') + ' games in the next week</h2><a href="#/results">See the latest results</a></div>';
    } else {
      const byDay = new Map();
      upcoming.forEach((g) => { const k = dayKey(g.start); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(g); });
      byDay.forEach((list) => {
        html += '<section><h2 class="day-title">' + esc(dayLabel(list[0].start) === fDay.format(list[0].start) ? fLongDay.format(list[0].start) : dayLabel(list[0].start) + ' · ' + fDay.format(list[0].start)) + '</h2></section>';
        const bySlot = new Map();
        list.forEach((g) => { const k = time(g.start); if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push(g); });
        html += '<div class="columns">';
        bySlot.forEach((games, t) => {
          games.sort((a, b) => teamSort(view(a).us, view(b).us));
          html += '<section><div class="slot-head"><h3>' + esc(t) + '</h3><span>' + games.length + (games.length === 1 ? ' game' : ' games') + '</span></div><div class="card">' +
            games.map((g) => {
              const v = view(g);
              return '<a class="row" href="#/team/' + v.us.id + '">' + logo(v.them, 30) + '<div class="age-tile"><b>' + esc(v.us.tile) + '</b><span>' + esc(v.us.sex.toUpperCase()) + '</span></div>' +
                '<div class="row-main"><span class="row-title">' + esc(v.us.short) + ' <span class="vs">' + esc(opponentText(v)) + '</span></span>' +
                '<span class="row-sub">' + esc(g.venueShort + ' · ' + g.court) + '</span></div></a>';
            }).join('') + '</div></section>';
        });
        html += '</div>';
      });
    }
    html += installBanner();
    return html;
  }

  function pageResults(seqParam) {
    const rounds = DATA.rounds;
    if (!rounds.length) return '<div class="notice"><h2>No games published yet</h2></div>';
    let seq = seqParam != null ? seqParam : ui.round;
    if (seq == null || !rounds.some((r) => r.seq === seq)) {
      const done = rounds.filter((r) => r.finals > 0);
      seq = (done.length ? done[done.length - 1] : rounds[0]).seq;
    }
    ui.round = seq;
    const round = rounds.find((r) => r.seq === seq);
    const games = round.games.filter((g) => {
      const v = view(g);
      return (ui.age === 'All' || v.us.age === ui.age) && (ui.sex === 'All' || v.us.gender === ui.sex);
    });
    const views = games.map((g) => view(g));
    const count = (r) => views.filter((v) => v.res === r).length;
    let best = null;
    views.forEach((v) => { if (v.res === 'W' && (!best || v.su - v.sth > best.su - best.sth)) best = v; });
    const ages = Array.from(new Set(DATA.games.map((g) => view(g).us.age))).sort((a, b) => ageNum(a) - ageNum(b));

    const range = fDay.format(round.first) === fDay.format(round.last) ? fDay.format(round.first) : fDay.format(round.first) + ' – ' + fDay.format(round.last);
    let html = '<div class="page-head"><div><div class="eyebrow">' + (round.finals === round.games.length ? 'Completed round' : round.finals ? 'In progress' : 'Upcoming round') + '</div>' +
      '<h1 class="page-title">' + esc(round.name) + '</h1><div class="page-sub">' + esc(range) + ' · ' + round.games.length + ' Lions games</div></div>' +
      '<div class="tabs" role="group" aria-label="Choose round">' + rounds.map((r) => '<button class="tab" type="button" data-round="' + r.seq + '" aria-pressed="' + (r.seq === seq) + '">' + esc(r.name.replace(/^Round\s*/i, 'R')) + '</button>').join('') + '</div></div>';

    html += '<section class="stats" aria-label="Round summary">' +
      '<div class="stat win"><span class="stat-label">Wins</span><span class="stat-value">' + count('W') + '</span></div>' +
      '<div class="stat"><span class="stat-label">Losses</span><span class="stat-value">' + count('L') + '</span></div>' +
      '<div class="stat"><span class="stat-label">Draws · club derbies</span><span class="stat-value">' + count('D') + ' · ' + count('CD') + '</span></div>' +
      '<div class="stat feature"><span class="stat-label">Biggest win</span><span class="stat-value">' + (best ? esc(groupName(best.us) + ' ' + best.us.short + ' · +' + (best.su - best.sth)) : '–') + '</span></div></section>';

    html += filterChips(ages);

    const groups = new Map();
    games.slice().sort((a, b) => teamSort(view(a).us, view(b).us)).forEach((g) => {
      const k = groupName(view(g).us);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    });
    if (!groups.size) return html + '<div class="notice">No games match these filters.</div>';
    html += '<section class="grid">';
    groups.forEach((list, name) => {
      const vs = list.map((g) => view(g));
      const w = vs.filter((v) => v.res === 'W').length, l = vs.filter((v) => v.res === 'L').length;
      html += '<article class="card"><div class="card-head"><h2>' + esc(name) + '</h2><span class="meta">' + (w + l ? w + 'W · ' + l + 'L' : '') + '</span></div>' +
        list.map((g) => gameRow(g)).join('') + '</article>';
    });
    return html + '</section>';
  }

  function teamRecord(id) {
    const vs = teamGames(id).map((g) => view(g, id));
    const done = vs.filter((v) => ['W', 'L', 'D', 'CD'].includes(v.res));
    const W = done.filter((v) => v.res === 'W' || (v.res === 'CD' && v.su > v.sth)).length;
    const L = done.filter((v) => v.res === 'L' || (v.res === 'CD' && v.su < v.sth)).length;
    const D = done.length - W - L;
    const pf = done.reduce((s, v) => s + (v.su || 0), 0), pa = done.reduce((s, v) => s + (v.sth || 0), 0);
    return { vs, done, W, L, D, pf, pa, avg: done.length ? Math.round((pf - pa) / done.length) : 0 };
  }

  function filterChips(ages) {
    const adults = Array.from(DATA.teams.values()).some((t) => t.sex === 'Men' || t.sex === 'Women');
    return '<div class="chips" role="group" aria-label="Filter">' +
      ['All'].concat(ages).map((a) => '<button class="chip" type="button" data-age="' + esc(a) + '" aria-pressed="' + (ui.age === a) + '">' + (a === 'All' ? 'All ages' : esc(a)) + '</button>').join('') +
      '<span class="chip-gap"></span>' +
      ['All', 'Boys', 'Girls'].map((s) => '<button class="chip" type="button" data-sex="' + s + '" aria-pressed="' + (ui.sex === s) + '">' + (s === 'All' ? (adults ? 'Everyone' : 'Boys + Girls') : adults ? (s === 'Boys' ? 'Boys + Men' : 'Girls + Women') : s) + '</button>').join('') + '</div>';
  }

  function pageTeams() {
    const allTeams = Array.from(DATA.teams.values()).sort(teamSort);
    const ages = Array.from(new Set(allTeams.map((t) => t.age))).sort((a, b) => ageNum(a) - ageNum(b));
    const teams = allTeams.filter((t) => (ui.age === 'All' || t.age === ui.age) && (ui.sex === 'All' || t.gender === ui.sex));
    const groups = new Map();
    teams.forEach((t) => { const k = groupName(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    const mine = myTeamIds();
    let html = '<div class="page-head"><div><div class="eyebrow">' + esc(CFG.seasonLabel) + '</div><h1 class="page-title">Teams</h1><div class="page-sub">' + allTeams.length + ' Lions teams. Tap a team, then star it to pin it to Game day.</div></div></div>' + filterChips(ages) + (teams.length ? '' : '<div class="notice">No teams match these filters.</div>') + '<section class="grid">';
    groups.forEach((list, name) => {
      html += '<article class="card"><div class="card-head"><h2>' + esc(name) + '</h2><span class="meta">' + list.length + ' teams</span></div>' +
        list.map((t) => {
          const r = teamRecord(t.id);
          const last = teamGames(t.id).slice(-1)[0];
          return '<a class="row" href="#/team/' + t.id + '"><div class="row-main"><span class="row-title">' + esc(t.short) + (mine.includes(t.id) ? ' <span class="vs">★ My team</span>' : '') + '</span>' +
            '<span class="row-sub">' + esc(last ? last.divisionShort : '') + '</span></div>' +
            '<span class="form">' + r.done.slice(-5).map((v) => badge(v.res === 'CD' ? (v.su > v.sth ? 'W' : 'L') : v.res, true)).join('') + '</span>' +
            '<span class="score" style="font-size:20px">' + r.W + '–' + r.L + (r.D ? '–' + r.D : '') + '</span></a>';
        }).join('') + '</article>';
    });
    return html + '</section>';
  }

  function pageTeam(id) {
    const t = DATA.teams.get(id);
    if (!t) return '<div class="notice"><h2>Team not found</h2><a href="#/teams">All teams</a></div>';
    const rec = teamRecord(id);
    const tg = teamGames(id);
    const live = tg.find((g) => g.status === 'live');
    const upcoming = tg.filter((g) => g.status === 'upcoming');
    const next = live || upcoming[0];
    const results = tg.filter((g) => g.status === 'final').reverse();
    const div = (next || tg[tg.length - 1] || {}).divisionShort || '';
    const mine = isMyTeam(id);

    let html = '<p style="margin:0"><a href="#/teams">← All teams</a></p><div class="team-layout"><div style="display:flex;flex-direction:column;gap:20px">' +
      '<section class="team-hero"><div class="team-hero-top"><img src="shield.png?v=2" alt=""><div class="team-hero-name"><div class="age">' + esc(groupName(t)) + '</div><h1>' + esc(t.short) + '</h1><div class="div">' + esc(div) + '</div></div>' +
      '<button class="star" type="button" data-star="' + id + '" aria-pressed="' + mine + '">' + starIcon + (mine ? 'My team' : 'Add to my teams') + '</button></div>' +
      '<div class="hero-stats"><div class="hero-stat"><span>Record</span><b>' + rec.W + '–' + rec.L + (rec.D ? '–' + rec.D : '') + '</b></div>' +
      '<div class="hero-stat"><span>For / against</span><b>' + rec.pf + '–' + rec.pa + '</b></div>' +
      '<div class="hero-stat"><span>Avg margin</span><b>' + (rec.avg > 0 ? '+' : '') + rec.avg + '</b></div></div></section>';

    if (next) {
      const v = view(next, id);
      const isToday = dayKey(next.start) === todayKey();
      html += '<section><h2 class="section-title">' + (live ? 'Live now' : 'Next game · ' + esc(next.round)) + '</h2><div class="next-card">' +
        '<div class="next-top"><span class="tag' + (live || isToday ? '' : ' quiet') + '">' + (live ? 'LIVE ' + esc(v.su ?? 0) + '–' + esc(v.sth ?? 0) : isToday ? 'TODAY' : esc(dayLabel(next.start).toUpperCase())) + '</span>' +
        '<strong>' + esc(fDay.format(next.start) + ' · ' + time(next.start)) + '</strong></div>' +
        (next.bye ? '<div class="next-opp">Bye</div>' :
          '<div><div class="page-sub">' + (v.home ? 'Home v' : 'Away to') + '</div><div class="next-opp">' + logo(v.them, 34) + esc(v.them.short) + '</div></div>' +
          '<div class="next-venue">' + pin + '<span>' + esc(next.venue + ' · ' + next.court) + '</span></div>' +
          (live ? '<a class="btn" href="#/game/' + next.id + '">Live box score</a>' : '') +
          '<a class="btn' + (live ? ' secondary' : '') + '" href="' + mapsUrl(next) + '" target="_blank" rel="noopener">Directions</a>') +
        '</div></section>';
    }
    html += '</div><div style="display:flex;flex-direction:column;gap:20px">';

    html += '<section><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 class="section-title">Results</h2><span class="form" aria-label="Last five results">' +
      rec.done.slice(-5).map((v) => badge(v.res === 'CD' ? (v.su > v.sth ? 'W' : 'L') : v.res, true)).join('') + '</span></div><div class="card">' +
      (results.length ? results.map((g) => {
        const v = view(g, id);
        const res = v.res === 'CD' ? (v.su > v.sth ? 'W' : v.su < v.sth ? 'L' : 'D') : v.res;
        const margin = (v.su || 0) - (v.sth || 0);
        const tag = g.bye ? 'div' : 'a';
        return '<' + tag + ' class="row"' + (g.bye ? '' : ' href="#/game/' + g.id + '"') + '><div class="rd"><span>RD</span><b>' + esc(g.round.replace(/\D/g, '') || '–') + '</b></div>' +
          '<div class="row-main"><span class="row-title">' + esc(opponentText(v)) + '</span><span class="row-sub">' + esc([fDay.format(g.start), g.venueShort].filter(Boolean).join(' · ')) + '</span></div>' +
          (g.bye ? badge('BYE') : '<div class="result-side"><span class="score">' + esc(v.su) + '–' + esc(v.sth) + '</span><span class="margin ' + res + '">' +
            ({ W: 'WIN +' + margin, L: 'LOSS ' + margin, D: 'DRAW', NR: 'NO RESULT' }[res] || '') + '</span></div>') + '</' + tag + '>';
      }).join('') : '<div class="empty">No results yet.</div>') + '</div></section>';

    html += '<section><h2 class="section-title">Player stats · season</h2><div class="card stats-card" data-team-stats="' + id + '"><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading player stats…</div></div></section>';

    const later = upcoming.filter((g) => g !== next);
    if (later.length) html += '<section><h2 class="section-title">Fixtures</h2><div class="card">' + later.map((g) => gameRow(g, { teamId: id, link: false, showRound: true, showDate: true, showDivision: false })).join('') + '</div></section>';
    return html + '</div></div>';
  }

  /* ---------- player stats ---------- */
  // Player names follow the club's rule: full names, except players BasketballConnect
  // marks as hidden, who are shown by shirt number only.
  const statsCache = new Map();
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
  function statsUrl(q) {
    const mock = new URLSearchParams(location.search).get('mock');
    if (mock) return 'stats-' + (q.matchId ? 'm' + q.matchId : 't' + q.teamId) + (q.period ? '-p' + q.period : '') + '.json';
    return CFG.apiBase + '/livescores/stats/public/v2/scoringByPlayer?competitionId=' + q.comp +
      '&aggregate=ALL&search=&sportRefId=2&userId=&period=' + (q.period || '') + '&offset=' + (q.teamId ? '0' : '') + '&limit=' + (q.teamId ? '100' : '') +
      '&matchId=' + (q.matchId || '') + (q.teamId ? '&teamId=' + q.teamId : '');
  }
  async function getStats(key, q, maxAgeMs) {
    const c = statsCache.get(key);
    if (c && Date.now() - c.at < maxAgeMs) return c.rows;
    const res = await fetch(statsUrl(q), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const rows = (Array.isArray(j) ? j : (j.result || [])).map((r) => ({
      teamId: Number(r.teamId),
      shirt: r.shirt == null ? '' : String(r.shirt),
      hidden: !!r.isHidden,
      name: r.isHidden ? '' : [r.firstName, r.lastName].filter(Boolean).join(' '),
      games: num(r.totalMatches),
      pts: num(r.totalPts != null ? r.totalPts : r.PTS),
      avg: num(r.avgPts),
      ft: num(r.FTMade), p2: num(r['2PMade']), p3: num(r['3PMade']),
      pf: num(r.PF), tf: num(r.TF), uf: num(r.UF)
    }));
    statsCache.set(key, { at: Date.now(), rows });
    return rows;
  }
  const playerCell = (p) => p.hidden
    ? '<td class="num shirt">' + esc(p.shirt) + '</td><td class="pname hidden-name">#' + esc(p.shirt) + '</td>'
    : '<td class="num shirt">' + esc(p.shirt) + '</td><td class="pname">' + esc(p.name) + '</td>';

  function boxTable(rows, title, isLions, team) {
    rows = rows.slice().sort((a, b) => b.pts - a.pts || num(a.shirt) - num(b.shirt));
    const extra = rows.some((p) => p.tf || p.uf);
    const tot = rows.reduce((t, p) => { ['pts', 'ft', 'p2', 'p3', 'pf', 'tf', 'uf'].forEach((k) => { t[k] += p[k]; }); return t; }, { pts: 0, ft: 0, p2: 0, p3: 0, pf: 0, tf: 0, uf: 0 });
    return '<article class="card' + (isLions ? ' mine' : '') + '"><div class="card-head"><h3 class="with-logo">' + logo(team, 28) + esc(title) + '</h3><span class="meta">' + tot.pts + ' pts</span></div>' +
      '<div class="table-wrap"><table class="box"><thead><tr><th class="num">#</th><th>Player</th><th class="num">PTS</th><th class="num">FT</th><th class="num">2P</th><th class="num">3P</th><th class="num">PF</th>' + (extra ? '<th class="num">TF</th><th class="num">UF</th>' : '') + '</tr></thead><tbody>' +
      (rows.length ? rows.map((p) => '<tr' + (p.pf >= 5 ? ' class="fouled-out"' : '') + '>' + playerCell(p) + '<td class="num strong">' + p.pts + '</td><td class="num">' + p.ft + '</td><td class="num">' + p.p2 + '</td><td class="num">' + p.p3 + '</td><td class="num' + (p.pf >= 4 ? ' warn' : '') + '">' + p.pf + '</td>' + (extra ? '<td class="num">' + p.tf + '</td><td class="num">' + p.uf + '</td>' : '') + '</tr>').join('')
        : '<tr><td colspan="' + (extra ? 9 : 7) + '" class="empty">No player stats recorded for this team yet. Some games only get stats entered after the final siren, or not at all.</td></tr>') +
      '</tbody>' + (rows.length ? '<tfoot><tr><td></td><td>Team</td><td class="num strong">' + tot.pts + '</td><td class="num">' + tot.ft + '</td><td class="num">' + tot.p2 + '</td><td class="num">' + tot.p3 + '</td><td class="num">' + tot.pf + '</td>' + (extra ? '<td class="num">' + tot.tf + '</td><td class="num">' + tot.uf + '</td>' : '') + '</tr></tfoot>' : '') +
      '</table></div></article>';
  }

  function pageGame(id) {
    const g = DATA.games.find((x) => x.id === id);
    if (!g) return '<div class="notice"><h2>Game not found</h2><a href="#/results">All results</a></div>';
    const v = view(g);
    const status = g.status === 'live' ? '<span class="tag">LIVE</span>' : g.status === 'final' ? '<span class="tag quiet">FINAL</span>' : '<span class="tag quiet">' + esc(dayLabel(g.start).toUpperCase() + ' ' + time(g.start)) + '</span>';
    return '<p style="margin:0"><a href="#/team/' + v.us.id + '">← ' + esc(groupName(v.us) + ' ' + v.us.short) + '</a></p>' +
      '<section class="game-hero"><div class="next-top">' + status + '<span class="game-meta">' + esc(g.round + ' · ' + fDay.format(g.start) + ' · ' + time(g.start)) + '</span></div>' +
      '<div class="game-lines"><a href="#/team/' + v.us.id + '" class="gt">' + logo(v.us, 34) + esc(groupName(v.us) + ' ' + v.us.short) + '</a><span class="gs">' + esc(g.status === 'upcoming' ? '–' : v.su ?? 0) + '</span>' +
      '<span class="gt opp">' + logo(v.them, 34) + esc(v.them ? (v.them.lions ? v.them.short : v.them.club) : 'Bye') + '</span><span class="gs opp">' + esc(g.status === 'upcoming' ? '–' : v.sth ?? 0) + '</span></div>' +
      '<div class="game-meta">' + esc([g.divisionShort, g.venue + (g.court ? ' · ' + g.court : '')].filter(Boolean).join(' · ')) + (g.status === 'live' ? ' · updates every 30 seconds' : '') + '</div></section>' +
      (g.status === 'upcoming' ? '<div class="notice">The box score appears here once the game starts.</div>' :
        '<div class="swipe"><div class="swipe-track">' +
        '<section class="card worm-card" data-worm="' + g.id + '"><div class="card-head"><h3>Quarter by quarter</h3><span class="meta">Points per quarter</span></div><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading…</div></section>' +
        '<section class="card worm-card" data-flow="' + g.id + '"><div class="card-head"><h3>Game flow</h3><span class="meta">Margin at the end of each quarter</span></div><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading…</div></section>' +
        '</div><div class="swipe-dots" role="tablist"><button type="button" class="on" aria-label="Quarter by quarter"></button><button type="button" aria-label="Game flow"></button></div></div>' +
        '<section class="box-grid" data-game-stats="' + g.id + '"><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading box score…</div></section>');
  }


  /* ---------- game flow ("worm") ---------- */
  // BasketballConnect's public stats can be filtered by period, which gives each team's points per quarter.
  // The worm plots our lead at the end of each quarter.
  async function hydrateWorm(el) {
    const id = parseInt(el.dataset.worm, 10);
    const g = DATA.games.find((x) => x.id === id);
    const v = view(g);
    const flowEl = app.querySelector('[data-flow="' + id + '"]');
    const drop = () => { const w = el.closest('.swipe'); if (w) w.remove(); else { el.remove(); if (flowEl) flowEl.remove(); } };
    if (!v.them) { drop(); return; }
    let per;
    try {
      const age = g.status === 'live' ? 25e3 : 6e5;
      per = await Promise.all([1, 2, 3, 4, 5].map((p) => getStats('m' + id + 'p' + p, { matchId: id, comp: g.comp.id, period: p }, age)));
    } catch (e) { if (el.isConnected) drop(); return; }
    if (!el.isConnected) return;
    const pts = (rows, t) => rows.filter((r) => r.teamId === t.id).reduce((a, r) => a + r.pts, 0);
    let q = per.map((rows) => ({ us: pts(rows, v.us), them: pts(rows, v.them) }));
    let last = 0; q.forEach((x, i) => { if (x.us || x.them) last = i; });
    if (!q.some((x) => x.us || x.them)) { drop(); return; }
    q = q.slice(0, Math.max(last + 1, g.status === 'live' ? last + 1 : Math.min(4, q.length)));
    const label = (i) => (i >= 4 ? 'OT' : 'Q' + (i + 1));
    const usName = v.us.short, themName = v.them.ours ? v.them.short : v.them.club;
    const max = Math.max(1, ...q.map((x) => Math.max(x.us, x.them)));
    let ru = 0, rt = 0;
    const rows = q.map((x, i) => {
      ru += x.us; rt += x.them;
      const tip = label(i) + ': ' + usName + ' ' + x.us + ', ' + themName + ' ' + x.them + ' (running ' + ru + '–' + rt + ')';
      return '<div class="qb-row" title="' + esc(tip) + '"><span class="qb-q">' + label(i) + '</span>' +
        '<div class="qb-l"><span class="qb-n">' + x.us + '</span><div class="qb-bar us" style="width:' + (x.us / max * 78).toFixed(1) + '%"></div></div>' +
        '<div class="qb-r"><div class="qb-bar them" style="width:' + (x.them / max * 78).toFixed(1) + '%"></div><span class="qb-n">' + x.them + '</span></div>' +
        '<span class="qb-run">' + ru + '–' + rt + '</span></div>';
    }).join('');
    const won = q.filter((x) => x.us > x.them).length, lost = q.filter((x) => x.us < x.them).length, drew = q.length - won - lost;
    const best = q.reduce((bi, x, i) => (x.us > q[bi].us ? i : bi), 0);
    const live = g.status === 'live';
    const summary = (live ? 'So far: won ' : 'Won ') + '<b>' + won + '</b> ' + (won === 1 ? 'quarter' : 'quarters') + ', lost <b>' + lost + '</b>' + (drew ? ', drew <b>' + drew + '</b>' : '') +
      '. Best quarter: <b>' + label(best) + ' (' + q[best].us + ' pts)</b>.';
    el.innerHTML = '<div class="card-head"><h3>Quarter by quarter</h3><span class="meta">Points per quarter</span></div>' +
      '<div class="qb-head"><span></span><span class="qb-us">' + esc(usName) + '</span><span>' + esc(themName) + '</span><span class="qb-run">Run</span></div>' +
      rows + '<div class="qb-foot">' + summary + '</div>' +
      ((ru !== (v.su || 0) || rt !== (v.sth || 0)) && g.status === 'final' ? '<p class="fine">Quarter scores come from player stats, which don\'t quite add up to the final score for this game.</p>' : '');

    if (flowEl) renderFlow(flowEl, g, v, q, label, usName, themName);
    setupSwipe(el.closest('.swipe'));
  }

  // Swipe between the quarter-by-quarter and game-flow cards; the dots follow and can be tapped.
  function setupSwipe(w) {
    if (!w || w.dataset.ready) return;
    w.dataset.ready = '1';
    const track = w.querySelector('.swipe-track'), dots = [...w.querySelectorAll('.swipe-dots button')];
    const step = () => (track.children[1] ? track.children[1].offsetLeft - track.children[0].offsetLeft : track.clientWidth);
    const mark = () => { const i = Math.round(track.scrollLeft / step()); dots.forEach((d, j) => { d.classList.toggle('on', i === j); d.setAttribute('aria-selected', i === j); }); };
    track.addEventListener('scroll', () => { cancelAnimationFrame(mark.f); mark.f = requestAnimationFrame(mark); }, { passive: true });
    dots.forEach((d, j) => d.addEventListener('click', () => track.scrollTo({ left: j * step(), behavior: 'smooth' })));
  }

  // The worm plots our lead at the end of each quarter.
  function renderFlow(el, g, v, q, label, usName, themName) {
    const id = g.id;
    let cu = 0, ct = 0;
    const pts2 = [{ x: 0, m: 0, us: 0, them: 0, lab: 'Start' }].concat(q.map((x, i) => { cu += x.us; ct += x.them; return { x: i + 1, m: cu - ct, us: cu, them: ct, lab: label(i) }; }));
    const W = 600, H = 220, L = 48, R = 20, T = 18, B = 34;
    const n = pts2.length - 1;
    const maxAbs = Math.max(4, ...pts2.map((p) => Math.abs(p.m)));
    const X = (x) => L + (x / n) * (W - L - R);
    const Y = (m) => T + (1 - (m + maxAbs) / (2 * maxAbs)) * (H - T - B);
    const line = pts2.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.m).toFixed(1)).join(' ');
    const area = line + ' L' + X(n) + ' ' + Y(0) + ' L' + X(0) + ' ' + Y(0) + ' Z';
    const tip = (p) => p.lab + ': ' + usName + ' ' + p.us + ' – ' + p.them + ' ' + themName + (p.m ? ' (' + (p.m > 0 ? '+' : '') + p.m + ')' : ' (level)');
    const fin = pts2[n];
    const svg = '<svg class="worm" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Score margin by quarter. ' + pts2.slice(1).map(tip).join('. ')) + '">' +
      '<defs><clipPath id="wa' + id + '"><rect x="0" y="0" width="' + W + '" height="' + Y(0) + '"></rect></clipPath><clipPath id="wb' + id + '"><rect x="0" y="' + Y(0) + '" width="' + W + '" height="' + (H - Y(0)) + '"></rect></clipPath></defs>' +
      pts2.slice(1).map((p) => '<line class="wgrid" x1="' + X(p.x) + '" x2="' + X(p.x) + '" y1="' + T + '" y2="' + (H - B) + '"></line>').join('') +
      '<path class="warea us" clip-path="url(#wa' + id + ')" d="' + area + '"></path><path class="warea them" clip-path="url(#wb' + id + ')" d="' + area + '"></path>' +
      '<line class="wzero" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(0) + '" y2="' + Y(0) + '"></line>' +
      '<path class="wline" d="' + line + '"></path>' +
      pts2.map((p) => '<g class="wpt"><circle class="whit" cx="' + X(p.x) + '" cy="' + Y(p.m) + '" r="16"></circle><circle class="wdot" cx="' + X(p.x) + '" cy="' + Y(p.m) + '" r="4.5"></circle><title>' + esc(tip(p)) + '</title></g>').join('') +
      '<text class="wlab" x="' + (L - 8) + '" y="' + (Y(maxAbs) + 4) + '" text-anchor="end">+' + maxAbs + '</text>' +
      '<text class="wlab" x="' + (L - 8) + '" y="' + (Y(0) + 4) + '" text-anchor="end">0</text>' +
      '<text class="wlab" x="' + (L - 8) + '" y="' + (Y(-maxAbs) + 4) + '" text-anchor="end">−' + maxAbs + '</text>' +
      pts2.slice(1).map((p) => '<text class="wlab" x="' + X(p.x) + '" y="' + (H - 8) + '" text-anchor="middle">' + p.lab + '</text>').join('') +
      '</svg>';
    const legend = '<div class="worm-legend"><span><i class="us"></i>' + esc(usName) + ' ahead</span><span><i class="them"></i>' + esc(themName) + ' ahead</span>' +
      '<b>' + (fin.m > 0 ? esc(usName) + ' by ' + fin.m : fin.m < 0 ? esc(themName) + ' by ' + (-fin.m) : 'Level') + (g.status === 'live' ? ' so far' : '') + '</b></div>';
    const table = '<div class="table-wrap"><table class="box qtable"><thead><tr><th>Team</th>' + q.map((x, i) => '<th class="num">' + label(i) + '</th>').join('') + '<th class="num">T</th></tr></thead><tbody>' +
      '<tr><td>' + esc(usName) + '</td>' + q.map((x) => '<td class="num">' + x.us + '</td>').join('') + '<td class="num strong">' + fin.us + '</td></tr>' +
      '<tr><td>' + esc(themName) + '</td>' + q.map((x) => '<td class="num">' + x.them + '</td>').join('') + '<td class="num strong">' + fin.them + '</td></tr></tbody></table></div>';
    el.innerHTML = '<div class="card-head"><h3>Game flow</h3><span class="meta">Margin at the end of each quarter</span></div>' + legend + svg + table;
  }

  async function hydrateStats() {
    const wormEl = app.querySelector('[data-worm]');
    if (wormEl) hydrateWorm(wormEl);
    const gameEl = app.querySelector('[data-game-stats]');
    if (gameEl) {
      const id = parseInt(gameEl.dataset.gameStats, 10);
      const g = DATA.games.find((x) => x.id === id);
      const v = view(g);
      try {
        const rows = await getStats('m' + id, { matchId: id, comp: g.comp.id }, g.status === 'live' ? 25e3 : 6e5);
        if (!gameEl.isConnected) return;
        const sides = [v.us, v.them].filter(Boolean);
        gameEl.innerHTML = sides.map((t) => boxTable(rows.filter((p) => p.teamId === t.id), groupName(t) + ' ' + (t.lions ? t.short : t.club), t.lions, t)).join('') +
          '<p class="fine">FT, 2P and 3P are shots made. PF is personal fouls, highlighted at 4. A player on 5 fouls is shown faded.</p>';
      } catch (e) {
        if (gameEl.isConnected) gameEl.innerHTML = '<div class="notice">Couldn\'t load the box score (' + esc(e.message) + '). It may not be recorded for this game.</div>';
      }
      if (g.status === 'live') { clearTimeout(hydrateStats.t); hydrateStats.t = setTimeout(() => { if (gameEl.isConnected && !document.hidden) hydrateStats(); }, 30e3); }
    }
    const teamEl = app.querySelector('[data-team-stats]');
    if (teamEl) {
      const id = parseInt(teamEl.dataset.teamStats, 10);
      try {
        const rows = (await getStats('t' + id, { teamId: id, comp: DATA.teams.get(id).comp.id }, 5 * 6e4)).filter((p) => p.teamId === id).sort((a, b) => b.pts - a.pts || num(a.shirt) - num(b.shirt));
        if (!teamEl.isConnected) return;
        teamEl.innerHTML = rows.length ? '<div class="table-wrap"><table class="box"><thead><tr><th class="num">#</th><th>Player</th><th class="num">GP</th><th class="num">PTS</th><th class="num">AVG</th><th class="num opt">FT</th><th class="num opt">2P</th><th class="num opt">3P</th><th class="num">PF</th></tr></thead><tbody>' +
          rows.map((p) => '<tr>' + playerCell(p) + '<td class="num">' + p.games + '</td><td class="num strong">' + p.pts + '</td><td class="num">' + p.avg.toFixed(1) + '</td><td class="num opt">' + p.ft + '</td><td class="num opt">' + p.p2 + '</td><td class="num opt">' + p.p3 + '</td><td class="num">' + p.pf + '</td></tr>').join('') +
          '</tbody></table></div>' : '<div class="empty">No player stats recorded yet.</div>';
      } catch (e) {
        if (teamEl.isConnected) teamEl.innerHTML = '<div class="empty">Couldn\'t load player stats right now.</div>';
      }
    }
  }

  /* ---------- add to home screen ---------- */
  // Android/desktop Chrome hand us an install prompt; iPhone needs the Share > Add to Home Screen steps.
  const SITE_NAME = 'Lions Den';
  const STORE_A2HS = 'lions.a2hsLater';
  let installPrompt = null;
  const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = () => /Android/i.test(navigator.userAgent);
  function installBanner() {
    if (isStandalone()) return '';
    const later = parseInt(store.get(STORE_A2HS) || '0', 10);
    if (later && Date.now() - later < 30 * 864e5) return '';
    if (!installPrompt && !isIOS() && !isAndroid()) return '';
    const phone = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"></rect><path d="M11 18h2"></path></svg>';
    return '<section class="a2hs" aria-label="Add to home screen"><div class="a2hs-top"><img src="icon-192.png" alt="" width="56" height="56"><div><h2>' + esc(SITE_NAME) + ' on your phone</h2>' +
      '<p>Scores, fixtures and venues one tap away, just like an app.</p></div></div>' +
      '<button class="a2hs-go" type="button" data-install>' + phone + 'Add to home screen</button>' +
      '<button class="a2hs-later" type="button" data-install-later>Not now</button></section>';
  }
  function installSheet() {
    const share = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="M7 8l5-5 5 5"></path><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path></svg>';
    const plus = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="M12 8v8M8 12h8"></path></svg>';
    const steps = isIOS()
      ? ['Tap the <b>Share</b> button ' + share + ' in the browser toolbar', 'Scroll down and choose <b>Add to Home Screen</b> ' + plus, 'Tap <b>Add</b> in the top corner']
      : ['Tap the browser menu <b>⋮</b> in the top corner', 'Choose <b>Add to Home screen</b> or <b>Install app</b>', 'Tap <b>Add</b> or <b>Install</b>'];
    const el = document.createElement('div');
    el.className = 'a2hs-sheet-wrap';
    el.innerHTML = '<div class="a2hs-sheet-bg" data-sheet-close></div><div class="a2hs-sheet" role="dialog" aria-modal="true" aria-label="Add to home screen"><div class="a2hs-grab"></div>' +
      '<div class="a2hs-sheet-hd"><img src="icon-192.png" alt="" width="52" height="52"><div><h2>' + esc(SITE_NAME) + '</h2><span>Add it to your home screen like an app</span></div></div>' +
      steps.map((t, i) => '<div class="a2hs-step"><b>' + (i + 1) + '</b><span>' + t + '</span></div>').join('') +
      '<button class="a2hs-done" type="button" data-sheet-close>Got it</button></div>';
    document.body.appendChild(el);
    el.querySelector('.a2hs-done').focus();
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (DATA && !app.querySelector('.a2hs')) route(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; const b = app.querySelector('.a2hs'); if (b) b.remove(); });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-install], [data-install-later], [data-sheet-close]');
    if (!t) return;
    if (t.hasAttribute('data-sheet-close')) { const w = document.querySelector('.a2hs-sheet-wrap'); if (w) w.remove(); return; }
    if (t.hasAttribute('data-install-later')) { store.set(STORE_A2HS, String(Date.now())); const b = app.querySelector('.a2hs'); if (b) b.remove(); return; }
    if (installPrompt) {
      const ev = installPrompt; installPrompt = null;
      ev.prompt();
      try { const r = await ev.userChoice; if (r && r.outcome === 'accepted') { const b = app.querySelector('.a2hs'); if (b) b.remove(); } } catch (err) { /* ignore */ }
    } else installSheet();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const w = document.querySelector('.a2hs-sheet-wrap'); if (w) w.remove(); } });

  /* ---------- routing ---------- */
  function route() {
    if (!DATA) return;
    const h = (location.hash || '#/').replace(/^#/, '');
    const parts = h.split('/').filter(Boolean);
    let html, nav = 'home';
    if (parts[0] === 'results') { nav = 'results'; html = pageResults(parts[1] != null ? parseInt(parts[1], 10) : null); }
    else if (parts[0] === 'teams') { nav = 'teams'; html = pageTeams(); }
    else if (parts[0] === 'team') { nav = 'teams'; html = pageTeam(parseInt(parts[1], 10)); }
    else if (parts[0] === 'game') { nav = 'results'; html = pageGame(parseInt(parts[1], 10)); }
    else html = pageHome();
    app.innerHTML = html;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    const title = parts[0] === 'game' ? 'Box score' : { home: 'Game day', results: 'Results', teams: 'Teams' }[nav];
    document.title = title + ' · Lions Den';
    hydrateStats();
  }

  app.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.round != null) { location.hash = '#/results/' + b.dataset.round; return; }
    if (b.dataset.age != null) { ui.age = b.dataset.age; route(); return; }
    if (b.dataset.sex != null) { ui.sex = b.dataset.sex; route(); return; }
    if (b.dataset.star != null) {
      const id = parseInt(b.dataset.star, 10);
      const ids = myTeamIds();
      const nextIds = ids.includes(id) ? ids.filter((v) => v !== id) : ids.concat(id);
      store.set(STORE_MY_TEAM, nextIds.length ? nextIds.join(',') : null);
      route();
    }
  });
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

  /* ---------- data ---------- */
  function dataUrl(comp, i) {
    const mock = new URLSearchParams(location.search).get('mock');
    if (mock && /^[\w.-]+\.json$/.test(mock)) return i === 0 ? mock : mock.replace(/\.json$/, '-' + comp.id + '.json');
    return CFG.apiBase + '/livescores/round/matches?competitionId=' + comp.id +
      '&divisionId=&teamIds=[' + comp.teamIds.join(',') + ']&ignoreStatuses=[1]';
  }
  // Every competition loads in parallel. One that fails is skipped, unless they all fail.
  async function fetchAll() {
    const results = await Promise.allSettled(CFG.competitions.map(async (comp, i) => {
      const res = await fetch(dataUrl(comp, i), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { comp, json: await res.json() };
    }));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw results[0].reason;
    return ok;
  }

  async function load(silent) {
    try {
      DATA = normalise(await fetchAll());
      document.getElementById('updated').textContent = 'Updated ' + time(DATA.fetchedAt);
      const y = window.scrollY;
      route();
      if (silent) window.scrollTo(0, y);
    } catch (err) {
      if (!DATA) {
        app.innerHTML = '<div class="notice"><h2>Couldn\'t load the latest games</h2><p>BasketballConnect didn\'t respond (' + esc(err.message) + '). Try again in a minute, or check the <a href="' + esc(CFG.competitions[0].sourceUrl) + '" target="_blank" rel="noopener">official fixture</a>.</p><button class="chip" type="button" onclick="location.reload()">Try again</button></div>';
      }
    }
    clearTimeout(refreshTimer);
    const anyLive = DATA && DATA.games.some((g) => g.status === 'live');
    const soon = DATA && DATA.games.some((g) => g.status === 'upcoming' && !g.postponed && Math.abs(g.start - Date.now()) < 3600e3);
    refreshTimer = setTimeout(() => { if (!document.hidden) load(true); else refreshTimer = null; }, anyLive || soon ? CFG.liveRefreshMs : 10 * 60e3);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !refreshTimer) load(true); });

  document.getElementById('season-label').textContent = 'Central Districts Basketball · ' + CFG.seasonLabel;
  document.getElementById('source-link').href = CFG.competitions[0].sourceUrl;
  load(false);
})();
