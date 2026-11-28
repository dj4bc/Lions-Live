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

  // Manual game changes from config.js (venue moves are not flagged by BasketballConnect).
  const CHANGES = new Map((CFG.gameChanges || []).map((c) => [Number(c.id), c]));

  function normalise(sets) {
    const games = [];
    sets.forEach(({ comp, json }) => (json.rounds || []).forEach((rd) => {
      (rd.matches || []).forEach((m) => {
        const t1 = parseTeam(m.team1), t2 = parseTeam(m.team2);
        [t1, t2].forEach((t) => { if (t) t.comp = comp; });
        if (!((t1 && t1.lions) || (t2 && t2.lions))) return;
        const st = (m.matchStatus || '').toUpperCase();
        const vc = m.venueCourt || {}, v = vc.venue || {};
        const ch = CHANGES.get(m.id) || {};
        const off = /POSTPONED|CANCEL|ABANDON/.test(st) || ch.type === 'postponed' || ch.type === 'cancelled' || ch.type === 'forfeit';
        games.push({
          id: m.id,
          round: rd.name || ('Round ' + ((rd.sequence || 0) + 1)),
          roundSeq: rd.sequence != null ? rd.sequence : 0,
          division: (rd.division && rd.division.name) || '',
          divisionShort: [comp.label === 'Juniors' ? '' : comp.label, shortDivision(rd.division && rd.division.name)].filter(Boolean).join(' · '),
          start: new Date(m.startTime),
          comp,
          postponed: off,
          offLabel: ch.type === 'forfeit' ? 'Forfeit' : /CANCEL/.test(st) || ch.type === 'cancelled' ? 'Cancelled' : /ABANDON/.test(st) ? 'Abandoned' : 'Postponed',
          moved: !off && ch.type === 'moved',
          changeNote: ch.note || '',
          status: st === 'ENDED' ? 'final' : (st && !/POSTPONED|CANCEL|ABANDON/.test(st) ? 'live' : 'upcoming'),
          t1, t2,
          s1: m.team1Score, s2: m.team2Score,
          r1: m.team1ResultId, r2: m.team2ResultId,
          bye: !t1 || !t2,
          venue: v.name || '',
          venueShort: v.shortName || v.name || '',
          court: vc.name || '',
          lat: vc.lat || v.lat, lng: vc.lng || v.lng,
          finals: !!m.isFinals, finalsAlias: m.finalsAlias || '',
          divisionId: m.divisionId || null
        });
      });
    }));
    // Unfinalised: still LIVE on BasketballConnect an hour after its scheduled finish (tip-off plus the
    // comp's game length). Usually the scorer stopped entering it. It clears once BasketballConnect ends it.
    const nowMs = Date.now();
    games.forEach((g) => {
      const mins = g.comp.gameMins || CFG.gameMins || 60;
      g.unfinal = g.status === 'live' && nowMs > g.start.getTime() + (mins + 60) * 60e3;
    });
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

  /* A final with no score recorded either side (shown as N/R). */
  const noResult = (g) => g.status === 'final' && !g.bye && !(g.s1 || 0) && !(g.s2 || 0);

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
    } else if (g.status === 'live') res = g.unfinal ? 'UF' : 'LIVE';
    return { g, us, them, su, sth, home, res };
  }

  const groupName = (t) => (t.age + ' ' + t.sex).trim();
  const ageNum = (a) => (a === 'Senior' ? 90 : a === 'Reserves' ? 91 : parseInt(String(a).replace(/\D/g, ''), 10) || 0);
  const teamSort = (a, b) => ageNum(a.age) - ageNum(b.age) || a.gender.localeCompare(b.gender) || a.short.localeCompare(b.short, undefined, { numeric: true });

  const BADGE_TEXT = { W: 'W', L: 'L', D: 'D', CD: 'CD', NR: 'N/R', BYE: 'BYE', LIVE: 'LIVE', UF: 'TBC' };
  const BADGE_LABEL = { W: 'Win', L: 'Loss', D: 'Draw', CD: 'Club derby', NR: 'No result', BYE: 'Bye', LIVE: 'Live', UF: 'Unfinalised: waiting on the final result' };
  const badge = (res, sm) => res ? '<span class="badge ' + res + (sm ? ' sm' : '') + '" title="' + BADGE_LABEL[res] + '" aria-label="' + BADGE_LABEL[res] + '">' + BADGE_TEXT[res] + '</span>' : '';
  /* Postponed and moved games stay flagged on Game day until their scheduled start. */
  const changeActive = (g) => (g.postponed || g.moved) && !g.bye && g.status === 'upcoming' && g.start.getTime() > Date.now();
  const changePill = (g) => g.postponed ? '<span class="chg off">' + esc(g.offLabel) + '</span>' : g.moved ? '<span class="chg moved">Venue change</span>' : '';
  const venueText = (g) => g.venueShort + (g.court ? ' · ' + g.court : '');
  const mapsUrl = (g) => g.lat && g.lng
    ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(g.lat + ',' + g.lng)
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(g.venue);
  const pin = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"></path><circle cx="12" cy="9.5" r="2.5"></circle></svg>';
  const toolsIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"></path></svg>';
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
    if (g.postponed && g.status === 'upcoming' && !opts.showDate) sub.push(dayLabel(g.start) + ' ' + time(g.start));
    if (g.status !== 'upcoming' || opts.showDate) sub.push(g.status === 'upcoming' ? fDay.format(g.start) : whenShort(g.start));
    let right = '';
    if (g.bye) right = badge('BYE');
    else if (g.postponed) right = changePill(g);
    else if (g.status === 'upcoming') right = '<span class="when">' + esc(opts.showDate ? time(g.start) : dayLabel(g.start) + '<br>' + time(g.start)).replace('&lt;br&gt;', '<br>') + '</span>';
    else right = '<span class="score">' + esc(v.su) + '–' + esc(v.sth) + '</span>' + badge(v.res);
    const href = (!g.bye && g.status !== 'upcoming') ? '#/game/' + g.id : '#/team/' + v.us.id;
    const tag = opts.link === false ? 'div' : 'a';
    return '<' + tag + ' class="row"' + (tag === 'a' ? ' href="' + href + '"' : '') + '>' +
      (g.bye ? '' : logo(v.them, 30)) + '<div class="row-main"><span class="row-title">' + esc(title) + ' <span class="vs">' + esc(opponentText(v)) + '</span>' + (g.moved && changeActive(g) ? ' ' + changePill(g) : '') + '</span>' +
      '<span class="row-sub">' + esc(sub.join(' · ')) + '</span></div>' + right + '</' + tag + '>';
  }

  function liveCard(g) {
    const v = view(g);
    const fin = g.status === 'final', uf = !fin && g.unfinal;
    return '<a class="live-card' + (fin ? ' fin' : uf ? ' unfinal' : '') + '" href="#/game/' + g.id + '" data-final="' + g.id + '">' +
      '<div class="live-top">' + (fin ? '' : '<span class="live-dot"></span>') + '<span class="label">' + (fin ? 'FINAL' : uf ? 'UNFINALISED' : 'LIVE') + '</span><span class="div">' + esc(g.divisionShort) + '</span></div>' +
      '<div class="live-lines"><span class="t1">' + logo(v.us, 26) + esc(groupName(v.us) + ' ' + v.us.short) + '</span><span class="s1" data-gs="us" data-g="' + g.id + '">' + esc(shownScore(g, v, 'us')) + '</span>' +
      '<span class="t2">' + logo(v.them, 26) + esc(v.them ? v.them.short : '') + '</span><span class="s2" data-gs="them" data-g="' + g.id + '">' + esc(shownScore(g, v, 'them')) + '</span></div>' +
      (uf ? '<div class="uf-note" data-since="' + g.id + '">Waiting on the final result</div>' : CFG.foulsBase ? '<div class="tick" data-tick="' + g.id + '" aria-live="polite"></div>' : '') +
      '<span class="live-foot">' + esc((fin ? 'Full time · ' : '') + g.venueShort + ' · ' + g.court) + ' · tap for the box score</span></a>';
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
    const justDone = (g) => g.status === 'final' && justFinal.has(g.id) && now - justFinal.get(g.id) < 15 * 60e3;
    const live = games.filter((g) => (g.status === 'live' && !g.unfinal) || justDone(g));
    // Unfinalised games from the last two days wait in their own spot until BasketballConnect ends them.
    const waiting = games.filter((g) => g.unfinal && !g.bye && g.start.getTime() > now - 2 * 864e5);
    const horizon = now + 8 * 864e5;
    const upcoming = games.filter((g) => g.status === 'upcoming' && !g.bye && (g.postponed ? changeActive(g) : g.start.getTime() > now - 3 * 3600e3) && g.start.getTime() < horizon);
    const changed = upcoming.filter(changeActive);
    const playing = upcoming.filter((g) => !g.postponed);
    // Finals with no score recorded (shown as N/R) are left out here; they still show in Results.
    const recent = games.filter((g) => g.status === 'final' && !justDone(g) && !g.bye && !noResult(g) && g.start.getTime() > now - 2 * 864e5).reverse();
    let html = '';

    const mine = myTeamIds().filter((id) => DATA.teams.has(id)).map((id) => DATA.teams.get(id)).sort(teamSort);
    if (mine.length) {
      html += '<section><h2 class="section-title">' + (mine.length > 1 ? 'My teams' : 'My team') + '</h2><div class="grid">' + mine.map((t) => {
        const tg = teamGames(t.id);
        const next = tg.find((g) => g.status !== 'final' && !g.unfinal && (!g.postponed || changeActive(g)));
        const last = tg.filter((g) => g.status === 'final' || g.unfinal).pop();
        return '<div class="card mine"><div class="card-head"><h3>' + esc(groupName(t) + ' ' + t.short) + '</h3><a class="meta" href="#/team/' + t.id + '">Team page</a>' + bellButton(t) + '</div>' +
          (next ? gameRow(next, { teamId: t.id, showDivision: false }) : '<div class="empty">No more games scheduled.</div>') +
          (last ? gameRow(last, { teamId: t.id, showDivision: false }) : '') + '</div>';
      }).join('') + '</div></section>';
    }

    html += '<div class="page-head"><div><div class="eyebrow">' + esc(fLongDay.format(new Date())) + '</div><h1 class="page-title">Game day</h1>' +
      '<div class="page-sub">' + (live.length ? live.length + ' live · ' : '') + playing.length + (playing.length === 1 ? ' Lions game' : ' Lions games') + ' in the next week</div></div></div>' + filterChips(ages);

    if (changed.length) {
      const nOff = changed.filter((g) => g.postponed).length, nMoved = changed.length - nOff;
      html += '<section class="changes" aria-label="Game changes"><div class="changes-head"><h2>Game changes</h2><span>' +
        [...['Postponed', 'Cancelled', 'Abandoned', 'Forfeit'].map((l) => { const n = changed.filter((g) => g.postponed && g.offLabel === l).length; return n ? n + ' ' + (l === 'Forfeit' ? (n === 1 ? 'forfeit' : 'forfeits') : l.toLowerCase()) : ''; }), nMoved ? nMoved + ' venue change' + (nMoved === 1 ? '' : 's') : ''].filter(Boolean).join(' · ') + '</span></div>' +
        changed.map((g) => {
          const v = view(g);
          const what = g.postponed ? 'Was ' + venueText(g) : 'Now at ' + venueText(g);
          return '<a class="row" href="#/team/' + v.us.id + '"><div class="age-tile"><b>' + esc(v.us.tile) + '</b><span>' + esc(v.us.sex.toUpperCase()) + '</span></div>' +
            '<div class="row-main"><span class="row-title">' + esc(v.us.short) + ' <span class="vs">' + esc(opponentText(v)) + '</span></span>' +
            '<span class="row-sub">' + esc(dayLabel(g.start) + ' ' + time(g.start) + ' · ' + what + (g.changeNote ? ' · ' + g.changeNote : '')) + '</span></div>' + changePill(g) + '</a>';
        }).join('') + '</section>';
    }

    if (live.length) html += '<section><h2 class="section-title">Live now</h2><div class="live-grid">' + live.map(liveCard).join('') + '</div></section>';
    if (waiting.length) html += '<section><h2 class="section-title">Waiting on result</h2><div class="live-grid">' + waiting.map(liveCard).join('') + '</div>' +
      '<p class="fine">' + (waiting.length === 1 ? 'This game' : 'These games') + ' finished over an hour ago but BasketballConnect hasn\'t finalised the result yet. The score is the last one entered. ' + (waiting.length === 1 ? 'It drops' : 'They drop') + ' off here once the result is final.</p></section>';

    if (recent.length) {
      html += '<section><h2 class="section-title">Just finished</h2><div class="card">' + recent.slice(0, 8).map((g) => gameRow(g, { showAge: true })).join('') + '</div>' +
        (recent.length > 8 ? '<p><a href="#/results">See all results</a></p>' : '') + '</section>';
    }

    if (!upcoming.length) {
      html += '<div class="notice"><h2>No ' + (ui.age === 'All' && ui.sex === 'All' ? 'Lions' : 'matching') + ' games in the next week</h2><a href="#/results">See the latest results</a></div>';
    } else {
      const byDay = new Map();
      upcoming.forEach((g) => { const k = dayKey(g.start); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(g); });
      let dayN = 0;
      byDay.forEach((list) => {
        if (dayN++ === 1) html += sponsorCard();
        html += '<section><h2 class="day-title">' + esc(dayLabel(list[0].start) === fDay.format(list[0].start) ? fLongDay.format(list[0].start) : dayLabel(list[0].start) + ' · ' + fDay.format(list[0].start)) + '</h2></section>';
        const bySlot = new Map();
        list.forEach((g) => { const k = time(g.start); if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push(g); });
        html += '<div class="columns">';
        bySlot.forEach((games, t) => {
          games.sort((a, b) => teamSort(view(a).us, view(b).us));
          html += '<section><div class="slot-head"><h3>' + esc(t) + '</h3><span>' + games.length + (games.length === 1 ? ' game' : ' games') + '</span></div><div class="card">' +
            games.map((g) => {
              const v = view(g);
              const chg = changeActive(g);
              return '<a class="row' + (g.postponed ? ' is-off' : g.moved && chg ? ' is-moved' : '') + '" href="#/team/' + v.us.id + '">' + logo(v.them, 30) + '<div class="age-tile"><b>' + esc(v.us.tile) + '</b><span>' + esc(v.us.sex.toUpperCase()) + '</span></div>' +
                '<div class="row-main"><span class="row-title">' + esc(v.us.short) + ' <span class="vs">' + esc(opponentText(v)) + '</span></span>' +
                '<span class="row-sub">' + (g.moved && chg ? '<b>Now at ' + esc(venueText(g)) + '</b>' : esc(g.venueShort + ' · ' + g.court)) + '</span></div>' + (chg ? changePill(g) : '') + '</a>';
            }).join('') + '</div></section>';
        });
        html += '</div>';
      });
      if (dayN === 1) html += sponsorCard();
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
      '<div class="tabs" role="group" aria-label="Choose round">' + rounds.map((r) => '<button class="tab' + (r.finals ? '' : ' future') + '" type="button" data-round="' + r.seq + '" aria-pressed="' + (r.seq === seq) + '"' + (r.finals ? '' : ' title="Not played yet"') + '>' + esc(r.name.replace(/^Round\s*/i, 'R')) + '</button>').join('') + '</div></div>';

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
    const live = tg.find((g) => g.status === 'live' && !g.unfinal);
    const upcoming = tg.filter((g) => g.status === 'upcoming' && (!g.postponed || changeActive(g)));
    const next = live || upcoming[0];
    const results = tg.filter((g) => g.status === 'final' || g.unfinal).reverse();
    const div = (next || tg[tg.length - 1] || {}).divisionShort || '';
    const mine = isMyTeam(id);

    let html = '<p style="margin:0"><a class="back-btn" href="#/teams"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All teams</a></p><div class="team-layout"><div style="display:flex;flex-direction:column;gap:20px">' +
      '<section class="team-hero"><div class="team-hero-top"><img src="shield.png?v=2" alt=""><div class="team-hero-name"><div class="age">' + esc(groupName(t)) + '</div><h1>' + esc(t.short) + '</h1><div class="div">' + esc(div) + '</div></div>' +
      '<div class="hero-btns"><button class="star" type="button" data-star="' + id + '" aria-pressed="' + mine + '">' + starIcon + (mine ? 'My team' : 'Add to my teams') + '</button>' +
      trackerLink(t, next && !next.bye ? view(next, id) : null, next) + '</div></div>' +
      '<div class="hero-stats"><div class="hero-stat"><span>Record</span><b>' + rec.W + '–' + rec.L + (rec.D ? '–' + rec.D : '') + '</b></div>' +
      '<div class="hero-stat"><span>For / against</span><b>' + rec.pf + '–' + rec.pa + '</b></div>' +
      '<div class="hero-stat"><span>Avg margin</span><b>' + (rec.avg > 0 ? '+' : '') + rec.avg + '</b></div></div>' + teamSponsor(t) + '</section>';

    if (next) {
      const v = view(next, id);
      const isToday = dayKey(next.start) === todayKey();
      const off = !live && next.postponed, moved = !live && next.moved && changeActive(next);
      html += '<section><h2 class="section-title">' + (live ? 'Live now' : 'Next game · ' + esc(next.round)) + '</h2><div class="next-card' + (off ? ' is-off' : moved ? ' is-moved' : '') + '">' +
        '<div class="next-top"><span class="tag' + (off ? ' off' : moved ? ' moved' : live || isToday ? '' : ' quiet') + '">' + (live ? 'LIVE ' + esc(v.su ?? 0) + '–' + esc(v.sth ?? 0) : off ? esc(next.offLabel.toUpperCase()) : moved ? 'VENUE CHANGE' : isToday ? 'TODAY' : esc(dayLabel(next.start).toUpperCase())) + '</span>' +
        '<strong>' + esc(fDay.format(next.start) + ' · ' + time(next.start)) + '</strong></div>' +
        (next.bye ? '<div class="next-opp">Bye</div>' :
          '<div><div class="page-sub">' + (v.home ? 'Home v' : 'Away to') + '</div><div class="next-opp">' + logo(v.them, 34) + esc(v.them.short) + '</div></div>' +
          (off ? '<div class="next-venue"><span>' + (next.offLabel === 'Forfeit' ? 'This game is a forfeit and will not be played.' : 'This game has been ' + esc(next.offLabel.toLowerCase()) + '. A new date will show here once BasketballConnect has it.') + (next.changeNote ? ' ' + esc(next.changeNote) : '') + '</span></div>' :
          '<div class="next-venue">' + pin + '<span>' + (moved ? '<b>Moved to</b> ' : '') + esc(next.venue + ' · ' + next.court) + (moved && next.changeNote ? ' · ' + esc(next.changeNote) : '') + '</span></div>' +
          (live ? '<a class="btn" href="#/game/' + next.id + '">Live box score</a>' : '') +
          '<a class="btn' + (live ? ' secondary' : '') + '" href="' + mapsUrl(next) + '" target="_blank" rel="noopener">Directions</a>')) +
        '</div></section>';
    }
    html += '<section data-ladder-wrap><h2 class="section-title">Ladder</h2><div class="card ladder-card" data-ladder="' + id + '"><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading ladder…</div></div></section>';
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
    html += '<section data-finals="' + id + '" hidden></section>';
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
      '<div class="table-wrap"><table class="box sortable"><thead><tr><th class="num">#</th><th>Player</th><th class="num">PTS</th><th class="num">FT</th><th class="num">2P</th><th class="num">3P</th><th class="num">PF</th>' + (extra ? '<th class="num">TF</th><th class="num">UF</th>' : '') + '</tr></thead><tbody>' +
      (rows.length ? rows.map((p) => '<tr' + (p.pf >= 5 ? ' class="fouled-out"' : '') + '>' + playerCell(p) + '<td class="num strong">' + p.pts + '</td><td class="num">' + p.ft + '</td><td class="num">' + p.p2 + '</td><td class="num">' + p.p3 + '</td><td class="num' + (p.pf >= 4 ? ' warn' : '') + '">' + p.pf + '</td>' + (extra ? '<td class="num">' + p.tf + '</td><td class="num">' + p.uf + '</td>' : '') + '</tr>').join('')
        : '<tr><td colspan="' + (extra ? 9 : 7) + '" class="empty">No player stats recorded for this team yet. Some games only get stats entered after the final siren, or not at all.</td></tr>') +
      '</tbody>' + (rows.length ? '<tfoot><tr><td></td><td>Team</td><td class="num strong">' + tot.pts + '</td><td class="num">' + tot.ft + '</td><td class="num">' + tot.p2 + '</td><td class="num">' + tot.p3 + '</td><td class="num">' + tot.pf + '</td>' + (extra ? '<td class="num">' + tot.tf + '</td><td class="num">' + tot.uf + '</td>' : '') + '</tr></tfoot>' : '') +
      '</table></div></article>';
  }

  function pageGame(id) {
    const g = DATA.games.find((x) => x.id === id);
    if (!g) return '<div class="notice"><h2>Game not found</h2><a href="#/results">All results</a></div>';
    const v = view(g);
    const status = g.unfinal ? '<span class="tag uf">UNFINALISED</span>' : g.status === 'live' ? '<span class="tag">LIVE</span>' : g.status === 'final' ? '<span class="tag quiet">FINAL</span>' : '<span class="tag quiet">' + esc(dayLabel(g.start).toUpperCase() + ' ' + time(g.start)) + '</span>';
    return '<p style="margin:0"><a class="back-btn" href="#/team/' + v.us.id + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>' + esc(groupName(v.us) + ' ' + v.us.short) + '</a></p>' +
      '<section class="game-hero" data-final="' + g.id + '"><div class="next-top">' + status + '<span class="game-meta">' + esc(g.round + ' · ' + fDay.format(g.start) + ' · ' + time(g.start)) + '</span></div>' +
      '<div class="game-lines"><a href="#/team/' + v.us.id + '" class="gt">' + logo(v.us, 34) + esc(groupName(v.us) + ' ' + v.us.short) + '</a><span class="gs" data-gs="us" data-g="' + g.id + '">' + esc(g.status === 'upcoming' ? '–' : shownScore(g, v, 'us')) + '</span>' +
      '<span class="gt opp">' + logo(v.them, 34) + esc(v.them ? (v.them.lions ? v.them.short : v.them.club) : 'Bye') + '</span><span class="gs opp" data-gs="them" data-g="' + g.id + '">' + esc(g.status === 'upcoming' ? '–' : shownScore(g, v, 'them')) + '</span></div>' +
      (g.status === 'live' && CFG.foulsBase ? '<div class="tick" data-tick="' + g.id + '" aria-live="polite"></div>' : '') +
      '<div class="game-meta">' + esc([g.divisionShort, g.venue + (g.court ? ' · ' + g.court : '')].filter(Boolean).join(' · ')) + (g.status === 'live' && !g.unfinal ? ' · updates every 30 seconds' : g.unfinal ? ' · waiting on BasketballConnect to finalise the result' : '') + '</div>' +
      (g.status !== 'upcoming' && CFG.foulsBase ? '<div class="lw" data-lw="' + g.id + '"' + (g.status === 'live' ? '' : ' hidden') + '></div>' : '') +
      (g.status !== 'upcoming' && !CFG.foulsBase && matchCentreUrl(g) ? '<a class="alog-btn" href="' + esc(matchCentreUrl(g)) + '" target="_blank" rel="noopener">' + (g.status === 'live' ? '<span class="alog-dot"></span>Live action log and fouls' : 'Action log on BasketballConnect') + ' ↗</a>' : '') + '</section>' +
      (g.status === 'upcoming' ? '<div class="notice">The box score appears here once the game starts.</div>' :
        (CFG.foulsBase && g.status === 'live' ? '<div class="stale-note" data-stale="' + g.id + '" hidden></div>' : '') +
        (CFG.foulsBase ? '<div class="pp" data-pp="' + g.id + '"><div class="pp-tabs" role="tablist"><button type="button" role="tab" class="on" data-pp-tab="0">Play by play<em hidden></em></button><button type="button" role="tab" data-pp-tab="1">' + (g.status === 'live' ? 'Live fouls' : 'Fouls') + '</button><span class="pp-ind"></span></div>' +
          '<div class="pp-track"><section class="card plays-card" data-plays="' + g.id + '" hidden></section><section class="card fouls-card" data-fouls="' + g.id + '" hidden></section></div>' +
          '<div class="swipe-dots pp-dots" aria-hidden="true"><button type="button" class="on" tabindex="-1"></button><button type="button" tabindex="-1"></button></div></div>' : '') +
        '<div class="swipe"><div class="swipe-track">' +
        '<section class="card worm-card flow-card" data-flow="' + g.id + '"><div class="flow-head"><h3>Game flow</h3></div><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading…</div></section>' +
        '<section class="card worm-card" data-worm="' + g.id + '"><div class="card-head"><h3>Quarter by quarter</h3><span class="meta">Points per quarter</span></div><div class="loading small"><span class="spinner" aria-hidden="true"></span> Loading…</div></section>' +
        '</div><div class="swipe-dots" role="tablist"><button type="button" class="on" aria-label="Game flow"></button><button type="button" aria-label="Quarter by quarter"></button></div></div>' +
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
    const id = g.id, live = g.status === 'live';
    let cu = 0, ct = 0;
    const pts2 = [{ x: 0, m: 0, us: 0, them: 0, lab: 'Start' }].concat(q.map((x, i) => { cu += x.us; ct += x.them; return { x: i + 1, m: cu - ct, us: cu, them: ct, lab: label(i) }; }));
    const n = pts2.length - 1, fin = pts2[n];
    const W = 600, L = 16, R = 16, T = 52, B = 56;
    let top = Math.max(0, ...pts2.map((p) => p.m)), bot = Math.min(0, ...pts2.map((p) => p.m));
    if (top === bot) { top = 1; bot = -1; }
    const H = T + B + Math.min(150, Math.max(60, (top - bot) * 14));
    const X = (x) => L + (x / n) * (W - L - R);
    const Y = (m) => T + ((top - m) / (top - bot)) * (H - T - B);
    const line = pts2.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.m).toFixed(1)).join(' ');
    const area = line + ' L' + X(n) + ' ' + Y(0) + ' L' + X(0) + ' ' + Y(0) + ' Z';
    const sgn = (m) => (m > 0 ? '+' + m : m < 0 ? '−' + (-m) : '0');
    const tip = (p) => p.lab + ': ' + usName + ' ' + p.us + ' – ' + p.them + ' ' + themName + (p.m ? ' (' + sgn(p.m) + ')' : ' (level)');
    const svg = '<svg class="worm" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Score margin by quarter. ' + pts2.slice(1).map(tip).join('. ')) + '">' +
      '<defs><clipPath id="wa' + id + '"><rect x="0" y="0" width="' + W + '" height="' + Y(0) + '"></rect></clipPath><clipPath id="wb' + id + '"><rect x="0" y="' + Y(0) + '" width="' + W + '" height="' + (H - Y(0)) + '"></rect></clipPath></defs>' +
      '<path class="warea us" clip-path="url(#wa' + id + ')" d="' + area + '"></path><path class="warea them" clip-path="url(#wb' + id + ')" d="' + area + '"></path>' +
      '<line class="wzero" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(0) + '" y2="' + Y(0) + '"></line>' +
      '<path class="wline" d="' + line + '"></path>' +
      pts2.map((p) => '<g class="wpt"><circle class="whit" cx="' + X(p.x) + '" cy="' + Y(p.m) + '" r="24"></circle><circle class="wdot" cx="' + X(p.x) + '" cy="' + Y(p.m) + '" r="10"></circle>' +
        (p.x ? '<text class="wval" x="' + X(p.x) + '" y="' + (p.m < 0 ? Y(p.m) + 46 : Y(p.m) - 22) + '" text-anchor="' + (p.x === n ? 'end' : 'middle') + '"' + (p.x === n ? ' dx="10"' : '') + '>' + sgn(p.m) + '</text>' : '') +
        '<title>' + esc(tip(p)) + '</title></g>').join('') +
      '</svg>';
    // Headline chips
    const ms = pts2.slice(1).map((p) => p.m);
    const lo = Math.min(0, ...ms), hi = Math.max(0, ...ms);
    const chips = [];
    if (lo < 0) chips.push('Biggest deficit ' + sgn(lo));
    if (hi > 0) chips.push('Biggest lead ' + sgn(hi));
    let bq = -1; q.forEach((x, i) => { if (x.us > x.them && (bq < 0 || x.us - x.them > q[bq].us - q[bq].them)) bq = i; });
    if (bq >= 0) chips.push('Won ' + label(bq) + ' by ' + (q[bq].us - q[bq].them));
    if (!live && lo < 0 && fin.m > 0) chips.push('Came back to win');
    else if (!live && lo < 0 && fin.m === 0) chips.push('Came back to draw');
    else if (ms.every((m) => m > 0)) chips.push('Led all game');
    const meta = live ? (fin.m > 0 ? 'Up by ' + fin.m : fin.m < 0 ? 'Down by ' + (-fin.m) : 'Level') + ' so far'
      : fin.m > 0 ? 'Won by ' + fin.m : fin.m < 0 ? 'Lost by ' + (-fin.m) : 'Level at full time';
    const strip = '<div class="flow-strip" style="grid-template-columns:repeat(' + q.length + ',1fr)">' + q.map((x, i) =>
      '<div class="fq ' + (x.us > x.them ? 'won' : x.us < x.them ? 'lost' : 'drew') + '"><span>' + label(i) + '</span><b>' + x.us + '–' + x.them + '</b></div>').join('') + '</div>';
    el.innerHTML = '<div class="flow-head"><h3>Game flow</h3><span class="meta">' + esc(meta) + '</span></div>' +
      (chips.length ? '<div class="flow-chips">' + chips.map((c) => '<span>' + esc(c) + '</span>').join('') + '</div>' : '') +
      '<div class="flow-side up">' + esc(usName) + ' ahead ↑</div>' + svg + '<div class="flow-side down">' + esc(themName) + ' ahead ↓</div>' + strip;
  }

  /* ---------- ladder ---------- */
  // BasketballConnect's public ladder for the team's division (one division per request).
  const compKey = (comp) => comp.key || ((comp.sourceUrl || '').match(/competitionUniqueKey=([\w-]+)/) || [])[1] || '';
  const ladderCache = new Map();
  async function getLadder(comp, divId) {
    const hit = ladderCache.get(divId);
    if (hit && Date.now() - hit.at < 60e3) return hit.data;
    const mock = new URLSearchParams(location.search).get('mock');
    const url = mock ? 'ladder-' + divId + '.json' : CFG.apiBase + '/livescores/teams/ladder/v2?divisionIds=' + divId + '&competitionKey=' + compKey(comp) + '&filteredOutCompStatuses=1&showForm=1&sportRefId=2';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    ladderCache.set(divId, { at: Date.now(), data });
    return data;
  }
  async function hydrateLadder(el) {
    const id = parseInt(el.dataset.ladder, 10);
    const wrap = el.closest('[data-ladder-wrap]');
    const drop = () => { if (wrap) wrap.remove(); else el.remove(); };
    const tgs = teamGames(id).slice().reverse();
    // Pool games set the ladder; finals and cross-grade games sit in their own divisions.
    const g = tgs.find((x) => x.divisionId && !x.bye && !x.finals && /^round\s*\d+/i.test(x.round)) || tgs.find((x) => x.divisionId && !x.finals) || tgs.find((x) => x.divisionId);
    if (!g || !compKey(g.comp)) { drop(); return; }
    let d, fin = null;
    const [lr, fr] = await Promise.allSettled([getLadder(g.comp, g.divisionId), getDivisionGames(g.comp, g.divisionId)]);
    if (lr.status !== 'fulfilled') { if (el.isConnected) drop(); return; }
    d = lr.value;
    if (fr.status === 'fulfilled') fin = fr.value;
    if (!el.isConnected) return;
    const rows = (d.ladders || []).filter((r) => !num(r.isHidden)).sort((a, b) => (num(a.rk) || 99) - (num(b.rk) || 99));
    if (!rows.some((r) => r.id === id)) { drop(); return; }
    const form = new Map((d.lastResults || []).map((x) => [x.teamId, (x.last5 || []).map((y) => y.code).reverse().slice(-3)]));
    const hasD = rows.some((r) => num(r.D) > 0);
    const dot = (c) => '<i class="ld-f ' + (c === 'WON' ? 'w' : c === 'LOST' ? 'l' : 'd') + '" title="' + (c === 'WON' ? 'Win' : c === 'LOST' ? 'Loss' : 'Draw') + '"></i>';
    const head = wrap && wrap.querySelector('.section-title');
    if (head) head.textContent = 'Ladder · ' + (rows[0].divisionName || g.division || '');
    const fx = fin ? finalsModel(fin, rows) : null;
    // On a team page the finals get their own section at the bottom of the page.
    const slot = app.querySelector('[data-finals="' + id + '"]');
    if (slot) { slot.hidden = !fx; slot.innerHTML = fx ? '<h2 class="section-title">Finals</h2><div class="card ladder-card finals-card">' + finalsHtml(fx, id) + '</div>' : ''; }
    el.innerHTML = '<table class="ladder"><thead><tr><th class="ld-pos">#</th><th class="ld-team">Team</th><th>P</th><th>W</th><th>L</th>' + (hasD ? '<th>D</th>' : '') + '<th>%</th><th class="ld-pts">Pts</th></tr></thead><tbody>' +
      rows.map((r, i) => {
        const cls = [r.id === id ? 'me' : isLions(r.name || '') ? 'club' : '', fx && fx.cut && i === fx.cut ? 'ld-cut' : ''].filter(Boolean).join(' ');
        const f = form.get(r.id) || [];
        const seed = fx && i < fx.spots ? '<span class="ld-seed">' + fx.firstLabel + '</span>' : '';
        return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td class="ld-pos">' + (r.rk || i + 1) + '</td><td class="ld-team"><span class="ld-name">' + esc(r.name) + seed + '</span>' + (f.length ? '<span class="ld-form" aria-label="Last results">' + f.map(dot).join('') + '</span>' : '') + '</td>' +
          '<td>' + num(r.P) + '</td><td>' + num(r.W) + '</td><td>' + num(r.L) + '</td>' + (hasD ? '<td>' + num(r.D) + '</td>' : '') +
          '<td>' + Math.round(num(r.goalAverage)) + '</td><td class="ld-pts">' + num(r.PTS) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="fine">% is points for divided by points against. Dots show each team\'s last 3 results, newest on the right.' +
      (fx && fx.cut ? ' The dashed line is the finals cut.' : '') + ' From BasketballConnect.</p>' +
      (fx && !slot ? finalsHtml(fx, id) : '');
  }

  /* ---------- finals: cut line and pairings under the ladder ---------- */
  // Every game in one division, so finals still listed as "1 v 4" or "WSF1 v WSF2" show up.
  const divCache = new Map();
  async function getDivisionGames(comp, divId) {
    const hit = divCache.get(divId);
    if (hit && Date.now() - hit.at < 60e3) return hit.data;
    const mock = new URLSearchParams(location.search).get('mock');
    const url = mock ? 'div-' + divId + '.json' : CFG.apiBase + '/livescores/round/matches?competitionId=' + comp.id + '&divisionId=' + divId + '&teamIds=&ignoreStatuses=[1]';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const games = [];
    (json.rounds || []).forEach((rd) => (rd.matches || []).forEach((m) => {
      if (m.divisionId && m.divisionId !== divId) return;
      const st = (m.matchStatus || '').toUpperCase();
      games.push({ id: m.id, round: rd.name || '', finals: !!m.isFinals || !!m.finalsAlias, alias: m.finalsAlias || '',
        start: new Date(m.startTime), n1: ((m.team1 && m.team1.name) || '').trim(), n2: ((m.team2 && m.team2.name) || '').trim(),
        s1: m.team1Score, s2: m.team2Score, status: st === 'ENDED' ? 'final' : (st && !/POSTPONED|CANCEL|ABANDON/.test(st) ? 'live' : 'upcoming'),
        venue: ((m.venueCourt || {}).venue || {}).shortName || ((m.venueCourt || {}).venue || {}).name || '', court: (m.venueCourt || {}).name || '' });
    }));
    divCache.set(divId, { at: Date.now(), data: games });
    return games;
  }

  // Finals stage label from its alias or round name: SF1 -> Semi final, GF1 -> Grand final.
  function stageName(g) {
    const a = g.alias.toUpperCase(), r = g.round;
    if (/^GF/.test(a) || /grand/i.test(r)) return 'Grand final';
    if (/^PF/.test(a) || /prelim/i.test(r)) return 'Preliminary final';
    if (/^SF/.test(a) || /semi/i.test(r)) return 'Semi final';
    if (/^QF/.test(a) || /quarter/i.test(r)) return 'Quarter final';
    if (/^EF/.test(a) || /elim/i.test(r)) return 'Elimination final';
    if (/cross/i.test(r)) return 'Crossover';
    return r.replace(/^finals\s*-\s*/i, 'Finals ') || 'Final';
  }

  function finalsModel(games, rows) {
    const finals = games.filter((g) => g.finals).sort((a, b) => a.start - b.start || a.alias.localeCompare(b.alias));
    if (!finals.length) return null;
    const pool = games.filter((g) => !g.finals);
    const poolDone = pool.length > 0 && pool.every((g) => g.status === 'final');
    // A placeholder is a ladder spot ("1", "4") or the winner/loser of another final ("WSF1", "LSF2").
    const seedOf = (n) => (/^\d+$/.test(n) ? parseInt(n, 10) : null);
    const byAlias = new Map(finals.filter((g) => g.alias).map((g) => [g.alias.toUpperCase(), g]));
    // No guessing: a ladder spot is only named once every pool game is done. "Winner SF1" lists the two teams in that semi.
    const ordinal = (k) => k + (k % 100 >= 11 && k % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th');
    const resolve = (n, g) => {
      const sd = seedOf(n);
      if (sd) {
        const r = rows[sd - 1];
        if (!r || !poolDone) return { seed: sd, name: ordinal(sd) + ' on ladder', real: false, pending: true, early: !!r };
        return { seed: sd, name: r.name, real: false, proj: true };
      }
      const ref = /^([WL])(\w+\d+)$/i.exec(n);
      if (ref && byAlias.has(ref[2].toUpperCase())) {
        const src = byAlias.get(ref[2].toUpperCase()), won = ref[1].toUpperCase() === 'W';
        const label = (won ? 'Winner ' : 'Loser ') + src.alias.toUpperCase();
        if (src.status === 'final' && src.s1 != null && src.s1 !== src.s2) {
          const s = resolve((src.s1 > src.s2) === won ? src.n1 : src.n2, src);
          return Object.assign({}, s, { from: label, proj: s.proj });
        }
        const ta = resolve(src.n1, src), tb = resolve(src.n2, src);
        const two = ta.pending || tb.pending ? '' : ta.name + ' or ' + tb.name;
        const lead = src.status === 'live' && src.s1 !== src.s2 ? ((src.s1 > src.s2) === won ? ta : tb) : null;
        return { name: label, real: false, pending: true, hint: two + (lead && !lead.pending ? ' (' + lead.name + ' ' + (won ? 'leading' : 'trailing') + ')' : '') };
      }
      const i = rows.findIndex((r) => r.name === n);
      return { seed: i >= 0 ? i + 1 : null, name: n, real: true };
    };
    const items = finals.map((g) => ({ g, stage: stageName(g), a: resolve(g.n1, g), b: resolve(g.n2, g) }));
    // Teams in the first finals stage = finals spots, which puts the cut line on the ladder.
    const firstStage = items[0].stage;
    const firstSeeds = new Set();
    items.filter((x) => x.stage === firstStage).forEach((x) => [x.a, x.b].forEach((t) => { if (t.seed) firstSeeds.add(t.seed); }));
    const spots = firstSeeds.size ? Math.max(...firstSeeds) : 0;
    const short = { 'Grand final': 'GF', 'Semi final': 'SF', 'Preliminary final': 'PF', 'Quarter final': 'QF', 'Elimination final': 'EF' };
    return { items, poolDone, spots, cut: spots && spots < rows.length ? spots : 0, firstLabel: short[firstStage] || 'F' };
  }

  function finalsHtml(fx, id) {
    const me = DATA.teams.get(id);
    const mine = (t) => me && t.name === me.name;
    const side = (t, score, show) => {
      const sub = t.from && !t.pending ? t.from : t.hint || '';
      return '<div class="fn-t' + (mine(t) ? ' me' : '') + (t.pending ? ' pending' : '') + '"><span class="fn-seed">' + (t.seed || '') + '</span>' +
        '<span class="fn-name"><span>' + esc(t.name) + '</span>' + (t.proj ? '<em class="fn-proj">' + 'Locked' + '</em>' : '') +
        (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span><span class="fn-score">' + (show ? esc(score) : '') + '</span></div>';
    };
    const html = fx.items.map(({ g, stage, a, b }) => {
      const show = g.status !== 'upcoming';
      const ours = DATA.games.find((x) => x.id === g.id);
      const where = [g.venue, g.court.replace(/^court\s*/i, 'Ct ')].filter(Boolean).join(' ');
      const when = (g.status === 'live' ? '<span class="fn-live">Live</span>' : g.status === 'final' ? 'Final' : esc(whenShort(g.start))) +
        (where && g.status !== 'final' ? ' · ' + esc(where) : '');
      const tag = ours ? 'a' : 'div';
      return '<' + tag + ' class="fn-game"' + (ours ? ' href="#/game/' + g.id + '"' : '') + '><div class="fn-h"><span>' + esc(stage) + (g.alias ? ' · ' + esc(g.alias) : '') + '</span><span>' + when + '</span></div>' +
        side(a, g.s1, show) + side(b, g.s2, show) + '</' + tag + '>';
    }).join('');
    const anyProj = fx.items.some((x) => x.a.proj || x.b.proj || x.a.pending || x.b.pending);
    const anyEarly = fx.items.some((x) => x.a.early || x.b.early);
    return '<div class="finals-block"><h3>Finals</h3>' + html +
      '<p class="fine">' + (anyProj ? (fx.poolDone ? 'Teams marked "Locked" are from the final ladder. ' : '') +
        (anyEarly && !fx.poolDone ? 'Ladder spots are named once all pool games are done. ' : '') +
        'BasketballConnect fills in the real names once each spot is decided. ' : '') + 'Tap a game with our team in it for the box score.</p></div>';
  }

  // Live cards on Game day read the scraper too, so baskets animate there as well as on the box score.
  async function pollLiveCards() {
    clearTimeout(pollLiveCards.t);
    const ticks = [...app.querySelectorAll('.live-card [data-tick]')];
    if (!ticks.length || !CFG.foulsBase) return;
    await Promise.all(ticks.map(async (el) => {
      const g = DATA.games.find((x) => x.id === parseInt(el.dataset.tick, 10));
      if (!g || g.status !== 'live') return;
      try {
        const res = await fetch(CFG.foulsBase.replace(/\/$/, '') + '/match-' + g.id + '.json', { cache: 'no-store' });
        if (res.ok) scoreMoments(g, await res.json());
      } catch (e) { /* keep the score as it is */ }
    }));
    pollLiveCards.t = setTimeout(() => { if (!document.hidden && app.querySelector('.live-card [data-tick]')) pollLiveCards(); }, 30e3);
  }

  // Live cards on Game day read the scraper too, so baskets animate there as well as on the box score.
  async function pollLiveCards() {
    clearTimeout(pollLiveCards.t);
    const ticks = [...app.querySelectorAll('.live-card [data-tick]')];
    if (!ticks.length || !CFG.foulsBase) return;
    await Promise.all(ticks.map(async (el) => {
      const g = DATA.games.find((x) => x.id === parseInt(el.dataset.tick, 10));
      if (!g || g.status !== 'live') return;
      try {
        const res = await fetch(CFG.foulsBase.replace(/\/$/, '') + '/match-' + g.id + '.json', { cache: 'no-store' });
        if (res.ok) scoreMoments(g, await res.json());
      } catch (e) { /* keep the score as it is */ }
    }));
    pollLiveCards.t = setTimeout(() => { if (!document.hidden && app.querySelector('.live-card [data-tick]')) pollLiveCards(); }, 30e3);
  }
  // Unfinalised cards: one scraper read for when the action log last changed, and its last score.
  function fillSince() {
    if (!CFG.foulsBase) return;
    app.querySelectorAll('[data-since]').forEach(async (el) => {
      const g = DATA.games.find((x) => x.id === parseInt(el.dataset.since, 10));
      if (!g) return;
      try {
        const res = await fetch(CFG.foulsBase.replace(/\/$/, '') + '/match-' + g.id + '.json', { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        const at = Date.parse(d.changedAt || d.updatedAt) || 0;
        if (!el.isConnected) return;
        if (at) el.textContent = 'No updates since ' + (dayKey(new Date(at)) === todayKey() ? '' : fWeekday.format(new Date(at)) + ' ') + time(new Date(at));
        const flow = (d.flow || []).filter((f) => Array.isArray(f) && f.length >= 3);
        const last = flow[flow.length - 1];
        if (last) {
          const v = view(g);
          const t1 = Math.max(num(g.s1), num(last[1])), t2 = Math.max(num(g.s2), num(last[2]));
          const card = el.closest('.live-card');
          const s1 = card.querySelector('[data-gs="us"]'), s2 = card.querySelector('[data-gs="them"]');
          if (s1 && s2) { s1.textContent = v.home ? t1 : t2; s2.textContent = v.home ? t2 : t1; }
        }
      } catch (e) { /* keep "Waiting on the final result" */ }
    });
  }
  async function hydrateStats() {
    if (app.querySelector('.live-card [data-tick]')) pollLiveCards();
    if (app.querySelector('[data-since]')) fillSince();
    const ladderEl = app.querySelector('[data-ladder]');
    if (ladderEl) hydrateLadder(ladderEl);
    const foulsEl = app.querySelector('[data-fouls]');
    if (foulsEl) hydrateFouls(foulsEl);
    const wormEl = app.querySelector('[data-worm]');
    if (wormEl) hydrateWorm(wormEl);
    const gameEl = app.querySelector('[data-game-stats]');
    if (gameEl) {
      const id = parseInt(gameEl.dataset.gameStats, 10);
      const g = DATA.games.find((x) => x.id === id);
      const v = view(g);
      try {
        let rows = await getStats('m' + id, { matchId: id, comp: g.comp.id }, g.status === 'live' ? 25e3 : 6e5);
        let fromLog = false;
        if (!rows.length && CFG.foulsBase) { const lr = await logRows(g); if (lr.length) { rows = lr; fromLog = true; } }
        if (!gameEl.isConnected) return;
        if (!rows.length) {
          gameEl.innerHTML = '<div class="notice stats-wait">' + (g.status === 'live'
            ? '<h3>Player stats arrive at full time</h3><p>BasketballConnect only publishes points, fouls and shooting for each player once the game ends. The score above is live, and this page fills in the box score by itself when the final siren goes.</p>'
            : '<h3>No player stats for this game</h3><p>Stats sometimes get entered a while after the final siren, or not at all. Check back later.</p>') + '</div>';
        } else {
        const sides = [v.us, v.them].filter(Boolean);
        gameEl.innerHTML = sides.map((t) => boxTable(rows.filter((p) => p.teamId === t.id), groupName(t) + ' ' + (t.lions ? t.short : t.club), t.lions, t)).join('') +
          '<p class="fine">' + (fromLog ? 'Live from BasketballConnect\'s action log, updated every 45 seconds. ' : '') + 'FT, 2P and 3P are shots made. PF is personal fouls, highlighted at 4. A player on 5 fouls is shown faded.</p>';
        applySorts(gameEl);
        }
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
        teamEl.innerHTML = rows.length ? '<div class="table-wrap"><table class="box sortable"><thead><tr><th class="num">#</th><th>Player</th><th class="num">GP</th><th class="num">PTS</th><th class="num">AVG</th><th class="num opt">FT</th><th class="num opt">2P</th><th class="num opt">3P</th><th class="num">PF</th></tr></thead><tbody>' +
          rows.map((p) => '<tr>' + playerCell(p) + '<td class="num">' + p.games + '</td><td class="num strong">' + p.pts + '</td><td class="num">' + p.avg.toFixed(1) + '</td><td class="num opt">' + p.ft + '</td><td class="num opt">' + p.p2 + '</td><td class="num opt">' + p.p3 + '</td><td class="num">' + p.pf + '</td></tr>').join('') +
          '</tbody></table></div>' : '<div class="empty">No player stats recorded yet.</div>';
        applySorts(teamEl);
      } catch (e) {
        if (teamEl.isConnected) teamEl.innerHTML = '<div class="empty">Couldn\'t load player stats right now.</div>';
      }
    }
  }

  /* ---------- game alerts (web push) ---------- */
  const STORE_ALERTS = 'lions.alertTeams'; // team ids with the bell on
  const PUSH = (CFG.pushBase || '').replace(/\/$/, '');
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  if (PUSH && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const pushReady = () => pushSupported() && Notification.permission === 'granted';
  const bellIds = () => String(store.get(STORE_ALERTS) || '').split(',').map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  const setBellIds = (ids) => store.set(STORE_ALERTS, ids.length ? ids.join(',') : null);
  const alertsOn = () => bellIds().length > 0 && pushReady();
  function alertTeams() {
    return bellIds().filter((id) => DATA.teams.has(id)).map((id) => { const t = DATA.teams.get(id); return { id, label: groupName(t) + ' ' + t.short }; });
  }
  function b64ToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  const postJSON = (path, body) => fetch(PUSH + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function syncAlerts(sub) {
    if (!PUSH || !pushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    sub = sub || await reg.pushManager.getSubscription();
    if (!sub) return;
    await postJSON('/subscribe', { site: location.origin, subscription: sub.toJSON(), teams: alertTeams() });
  }
  async function enableAlerts() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Permission was not given.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await fetch(PUSH + '/key').then((r) => r.json());
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    }
    return sub;
  }
  async function disableAlerts() {
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { postJSON('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } catch (e) { /* ignore */ }
  }
  const BELL = (on) => '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M12 3.5a6 6 0 0 0-6 6V14l-2 3h16l-2-3V9.5a6 6 0 0 0-6-6Z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10 20a2 2 0 0 0 4 0"/></svg>';
  // Round bell on each "My team" card: alerts for that team's game start and final score.
  function bellButton(t) {
    if (!PUSH) return '';
    const name = groupName(t) + ' ' + t.short;
    if (isIOS() && !isStandalone()) return '<button type="button" class="bell" data-install aria-label="' + esc('Game alerts for ' + name + ': add to home screen first') + '">' + BELL(false) + '</button>';
    if (!pushSupported()) return '';
    const on = alertsOn() && bellIds().includes(t.id);
    return '<button type="button" class="bell' + (on ? ' on' : '') + '" data-bell="' + t.id + '" aria-pressed="' + on + '" aria-label="' + esc('Game alerts for ' + name) + '">' + BELL(on) + '</button>';
  }
  function toast(html) {
    const old = document.querySelector('.toast'); if (old) old.remove();
    document.body.insertAdjacentHTML('beforeend', '<div class="toast" role="status">' + html + '</div>');
    const el = document.querySelector('.toast');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.remove(), 4000);
  }
  async function toggleBell(id) {
    const t = DATA.teams.get(id); const name = t ? groupName(t) + ' ' + t.short : 'this team';
    const ids = bellIds(); const turnOn = !(alertsOn() && ids.includes(id));
    if (turnOn) {
      const firstTime = !alertsOn();
      const sub = await enableAlerts();
      setBellIds(ids.filter((v) => v !== id).concat(id));
      await syncAlerts(sub);
      if (firstTime) postJSON('/test', { endpoint: sub.endpoint }).catch(() => {});
      toast(BELL(true) + '<span>Alerts on for ' + esc(name) + ': game start and final score.</span>');
    } else {
      const next = ids.filter((v) => v !== id);
      setBellIds(next);
      if (next.length) await syncAlerts(); else await disableAlerts();
      toast(BELL(false) + '<span>Alerts off for ' + esc(name) + '.</span>');
    }
  }


  /* ---------- sponsors ---------- */
  const SP = CFG.sponsors || {};
  const sponsor = (k) => (k && SP.list && SP.list[k]) || null;
  const spLink = (s, cls, inner) => '<a class="' + cls + '" href="' + esc(s.url) + '" target="_blank" rel="noopener sponsored">' + inner + '</a>';
  const spLogo = (s, cls) => spLink(s, 'sp-logo' + (s.dark ? ' dark' : '') + (cls ? ' ' + cls : ''), '<img src="' + esc(s.logo) + '" alt="' + esc(s.name) + '" loading="lazy">');
  function renderSponsorFrame() {
    const strip = document.getElementById('sponsor-strip'), p = sponsor(SP.presenting);
    if (strip && p) strip.innerHTML = '<div class="wrap">Game day presented by ' + spLogo(p) + '</div>';
    const wall = document.getElementById('sponsor-wall'), list = (SP.wall || []).map(sponsor).filter(Boolean);
    if (wall && (list.length || SP.wallSlots)) {
      wall.innerHTML = '<section class="sp-wall"><h2>Thanks to our sponsors</h2><div class="sp-wall-grid">' +
        list.map((s, i) => spLogo(s, i < 2 ? 'major' : '')).join('') +
        Array.from({ length: SP.wallSlots || 0 }, () => '<span class="sp-slot">Your logo here</span>').join('') + '</div></section>';
    }
  }
  function sponsorCard() {
    const s = sponsor(SP.feed);
    if (!s) return '';
    return '<aside class="sp-card"><span class="sp-tag">Club sponsor</span>' + spLogo(s, 'sq') + '<div><b>' + esc(s.name) + '</b>' +
      (s.blurb ? '<p>' + esc(s.blurb) + '</p>' : '') + spLink(s, 'sp-cta', esc(s.cta || 'Visit website') + ' →') + '</div></aside>';
  }
  // Team stat tracker on the Hoops Live portal. Coaches unlock it with their team's PIN.
  // The next game (opponent, date, match id) goes along so the coach doesn't have to type it.
  function trackerLink(t, v, g) {
    if (!CFG.trackerBase || !CFG.trackerClub || !t.lions) return '';
    const team = groupName(t) + ' ' + t.short;
    const q = '?' + new URLSearchParams(Object.assign(v && g ? { opp: v.them.short || v.them.name || '', d: dayKey(g.start), m: String(g.id), r: g.round || '' } : {}, { back: location.href })).toString();
    return '<a class="coach-btn" href="' + CFG.trackerBase.replace(/\/$/, '') + '/track/#/t/' + encodeURIComponent(CFG.trackerClub) + '/' + encodeURIComponent(team) + q + '" aria-label="Coach: team stat tracker">' + toolsIcon + 'Coach</a>';
  }
  function teamSponsor(t) {
    const s = sponsor(SP.teams && SP.teams[groupName(t) + ' ' + t.short]);
    return s ? '<div class="sp-team"><span>' + esc(groupName(t)) + ' proudly<br>supported by</span>' + spLogo(s) + '</div>' : '';
  }

  // BasketballConnect's own match centre (action log, fouls). It's public to view, but its data feed is only for their site, so we link to it.
  function matchCentreUrl(g) {
    const m = /competitionUniqueKey=([\w-]+)/.exec((g.comp && g.comp.sourceUrl) || '');
    return m ? 'https://registration.basketballconnect.com/matchSummary?matchId=' + g.id + '&competitionId=' + g.comp.id + '&competitionUniqueKey=' + m[1] : '';
  }

  // Player rows built from the scraper's action-log file, used while BasketballConnect's stats feed is still empty.
  async function logRows(g) {
    try {
      const res = await fetch(CFG.foulsBase.replace(/\/$/, '') + '/match-' + g.id + '.json', { cache: 'no-store' });
      if (!res.ok) return [];
      const d = await res.json();
      const out = [];
      [['team1', g.t1], ['team2', g.t2]].forEach(([side, team]) => {
        if (!team) return;
        ((d.players || {})[side] || []).forEach((p) => {
          if (p.pts == null) return; // older files only carry fouls
          const hidden = /^hidden player$/i.test(p.player || '');
          out.push({ teamId: team.id, shirt: String(p.no || ''), name: hidden ? '' : (p.player || ''), hidden,
            pts: num(p.pts), ft: num(p.ft), p2: num(p.p2), p3: num(p.p3), pf: num(p.fouls), tf: 0, uf: 0 });
        });
      });
      return out;
    } catch (e) { return []; }
  }

  /* ---------- final siren: the moment a game you are watching is decided ---------- */
  // When a refresh shows a game that was live is now final, its score box (Game day card or box score)
  // flashes like the siren and a banner opens with the result. It plays once per game; a loss or draw
  // gets a plain "Full time" banner with no siren.
  const justFinal = new Map(); // game id -> when this page saw it finish
  const sirenQueue = new Set();
  let fromAlert = new URLSearchParams(location.search).get('from') === 'alert';
  function playSirens() {
    sirenQueue.forEach((id) => {
      const boxes = app.querySelectorAll('[data-final="' + id + '"]');
      if (!boxes.length) return; // play it when the game is next on screen
      sirenQueue.delete(id);
      const g = DATA.games.find((x) => x.id === id);
      if (!g) return;
      const v = view(g), u = num(v.su), t = num(v.sth), win = u > t;
      const them = v.them ? (v.them.ours ? v.them.short : v.them.club) : '';
      const big = win ? (CFG.clubShort || v.us.short) + ' win' : 'Full time';
      const small = u + '–' + t + (win ? ' · by ' + (u - t) : t > u ? ' · ' + (them ? them + ' by ' : 'lost by ') + (t - u) : ' · drawn');
      boxes.forEach((box) => {
        const s = document.createElement('div'); s.className = 'fs-siren'; s.setAttribute('aria-hidden', 'true');
        const b = document.createElement('div'); b.className = 'fs-banner' + (win ? '' : ' loss'); b.setAttribute('role', 'status');
        b.innerHTML = '<span class="big">' + esc(big) + '</span><small>' + esc(small) + '</small>';
        box.append(s, b);
        if (win) requestAnimationFrame(() => s.classList.add('go'));
        setTimeout(() => b.classList.add('show'), win ? 700 : 100);
        setTimeout(() => { b.classList.remove('show'); setTimeout(() => { b.remove(); s.remove(); }, 500); }, win ? 4500 : 3000);
      });
    });
  }

  /* ---------- score moments: animate each new basket on the live score box ---------- */
  // Each scraper read gives the running score after every scoring play (flow) and each player's points.
  // Flow entries added since the last read are the new baskets, in order. The scorer is the player on
  // that side whose points went up by the same amount. A few baskets in one read play one after the
  // other; four or more show as one summary line instead of a long replay.
  const seen = new Map(); // game id -> { n, s: [t1, t2], shown: [t1, t2], pts, q }
  const BALL = '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="#E8822A" stroke="#7A3B0C" stroke-width="1.5"/><path d="M1 13h24M13 1v24M4.5 4.5c5 4 5 13 0 17M21.5 4.5c-5 4-5 13 0 17" fill="none" stroke="#7A3B0C" stroke-width="1.3"/></svg>';
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const themShort = (v) => v.them ? (v.them.ours ? v.them.short : v.them.club) : '';
  const shortName = (n) => { const w = String(n).trim().split(/\s+/); return w.length > 1 ? w[0] + ' ' + w[w.length - 1][0] : w[0]; };
  // The score box shows the newer of BasketballConnect's score and the scraper's, so it never steps back.
  function shownScore(g, v, who) {
    const api = who === 'us' ? (v.su ?? 0) : (v.sth ?? 0);
    const st = seen.get(g.id);
    if (!st || g.status !== 'live') return api;
    return Math.max(num(api), st.shown[(who === 'us') === !!v.home ? 0 : 1]);
  }
  function setShown(g, v) {
    ['us', 'them'].forEach((who) => {
      app.querySelectorAll('[data-g="' + g.id + '"][data-gs="' + who + '"]').forEach((el) => { if (el.firstChild) el.firstChild.nodeValue = shownScore(g, v, who); });
    });
  }
  function scoreMoments(g, d) {
    const stale = staleNote(d, g);
    if (stale) { app.querySelectorAll('[data-tick="' + g.id + '"]').forEach((t) => { t.textContent = stale.split('. ')[0]; }); return; }
    const v = view(g);
    const flow = (d.flow || []).filter((f) => Array.isArray(f) && f.length >= 3);
    const pts = {};
    ['team1', 'team2'].forEach((side) => ((d.players || {})[side] || []).forEach((p) => { if (p.pts != null) pts[side + '#' + p.no] = { pts: num(p.pts), p }; }));
    const last = flow.length ? flow[flow.length - 1] : [0, 0, 0];
    const prev = seen.get(g.id);
    const at = Date.parse(d.updatedAt) || 0;
    if (prev && at && prev.at && at < prev.at) return; // an older read that arrived late
    const t0 = app.querySelector('[data-tick="' + g.id + '"]');
    // Same read as before (the page re-rendered): leave any replay that is still playing alone.
    if (prev && flow.length === prev.n && last[1] === prev.s[0] && last[2] === prev.s[1] && t0 && t0.innerHTML) { prev.pts = pts; prev.at = Math.max(prev.at || 0, at); setShown(g, v); return; }
    if (prev) clearTimeout(prev.q);
    const st = { n: flow.length, s: [last[1], last[2]], shown: [last[1], last[2]], pts, q: null, at };
    seen.set(g.id, st);
    const tickEl = () => app.querySelector('[data-tick="' + g.id + '"]');
    const lineFor = (s) => { const u = Math.max(v.home ? s[0] : s[1], num(v.su)), t = Math.max(v.home ? s[1] : s[0], num(v.sth)); // never disagree with the box
      return (u > t ? esc(v.us.short) + ' lead ' : u < t ? esc(themShort(v)) + ' lead ' : 'Level at ') + Math.max(u, t) + '–' + Math.min(u, t); };
    const tick = (html, anim) => app.querySelectorAll('[data-tick="' + g.id + '"]').forEach((t) => {
      t.innerHTML = html; if (anim) { t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); } });
    // First read, a score correction, or nothing new: show the score with no animation.
    const fresh = prev && flow.length > prev.n && last[1] >= prev.s[0] && last[2] >= prev.s[1];
    if (!fresh) {
      setShown(g, v);
      const t = tickEl();
      if (t && (!prev || flow.length !== prev.n || !t.innerHTML)) tick(flow.length ? 'Score: ' + lineFor(st.shown) : 'Waiting for the first basket…');
      return;
    }
    // The new baskets, and who scored them.
    const gain = {};
    Object.keys(pts).forEach((k) => { const was = prev.pts[k] ? prev.pts[k].pts : 0; if (pts[k].pts > was) gain[k] = pts[k].pts - was; });
    const evs = [];
    let a = [prev.s[0], prev.s[1]];
    flow.slice(prev.n).forEach((f) => {
      const d1 = f[1] - a[0], d2 = f[2] - a[1];
      a = [f[1], f[2]];
      const side = d1 > 0 ? 'team1' : d2 > 0 ? 'team2' : null, n = Math.max(d1, d2);
      if (!side || n > 4) return;
      const keys = Object.keys(gain).filter((k) => k.startsWith(side + '#') && gain[k] >= n);
      const k = keys.find((x) => gain[x] === n) || keys[0];
      let who = null;
      if (k) {
        gain[k] -= n; if (!gain[k]) delete gain[k];
        const p = pts[k].p;
        who = '#' + p.no + (!p.player || /^hidden player$/i.test(p.player) ? '' : ' ' + shortName(p.player));
      }
      evs.push({ side, n, who, mine: (side === 'team1') === !!v.home, after: a.slice() });
    });
    if (!evs.length || document.hidden || evs.length >= 4) {
      setShown(g, v);
      if (!evs.length) return;
      const u = evs.filter((e) => e.mine).reduce((x, e) => x + e.n, 0), t = evs.filter((e) => !e.mine).reduce((x, e) => x + e.n, 0);
      if (!document.hidden) { bump(g, 'us', u); bump(g, 'them', t); }
      tick('<b>' + (u >= t ? esc(v.us.short) + ' ' + u + '–' + t : esc(themShort(v)) + ' ' + t + '–' + u) + '</b> since the last update · ' + lineFor(st.shown), true);
      return;
    }
    st.shown = [prev.s[0], prev.s[1]];
    let i = 0;
    const step = () => {
      const e = evs[i++];
      if (!e || !tickEl()) { st.shown = [last[1], last[2]]; setShown(g, v); return; }
      st.shown = e.after;
      setShown(g, v);
      bump(g, e.mine ? 'us' : 'them', e.n);
      const shot = e.n === 3 ? 'a three' : e.n === 2 ? '2' : e.n === 1 ? 'a free throw' : e.n;
      tick('<b>' + esc(e.who || (e.mine ? v.us.short : themShort(v))) + '</b> ' + (e.who && !e.mine && themShort(v) ? '(' + esc(themShort(v)) + ') ' : '') + 'scores ' + shot + ' · ' + lineFor(e.after), true);
      if (i < evs.length) st.q = setTimeout(step, reduceMotion() ? 700 : 1600);
    };
    step();
  }
  // A ball bounces beside the score, a gold ring ripples out and "+2" floats up.
  function bump(g, who, n) {
    if (n) app.querySelectorAll('[data-g="' + g.id + '"][data-gs="' + who + '"]').forEach((sc) => bumpOne(sc, n));
  }
  function bumpOne(sc, n) {
    const f = document.createElement('span'); f.className = 'sm-float'; f.textContent = '+' + n; f.setAttribute('aria-hidden', 'true'); sc.appendChild(f);
    setTimeout(() => f.remove(), 1400);
    if (reduceMotion()) return;
    const hero = sc.closest('.game-hero, .live-card'), h = hero.getBoundingClientRect(), r = sc.getBoundingClientRect();
    const rg = document.createRange(); rg.selectNodeContents(sc.firstChild);
    const x = r.right - h.left - rg.getBoundingClientRect().width - 12, y = r.bottom - h.top - 4;
    const bb = document.createElement('div'); bb.className = 'sm-ball'; bb.innerHTML = BALL; bb.style.left = (x - 9) + 'px'; bb.style.top = (y - 18) + 'px';
    const ring = document.createElement('div'); ring.className = 'sm-ring'; ring.style.left = x + 'px'; ring.style.top = y + 'px';
    hero.append(bb, ring);
    setTimeout(() => { bb.remove(); ring.remove(); }, 1400);
  }


  /* ---------- live fouls (from the action log, via the club's scraper) ---------- */
  // The scraper reads BasketballConnect's public match page and publishes <foulsBase>/match-<id>.json:
  // { updatedAt, status, quarter, players: { team1: [{ no, player, fouls }], team2: [...] }, teamFouls: { team1: [q1..], team2: [q1..] } }
  // team1 is the first-listed (home) team, the same as g.t1.
  async function hydrateFouls(el) {
    const id = parseInt(el.dataset.fouls, 10);
    const g = DATA.games.find((x) => x.id === id);
    if (!g || !CFG.foulsBase) return;
    let d;
    try {
      const res = await fetch(CFG.foulsBase.replace(/\/$/, '') + '/match-' + id + '.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      d = await res.json();
    } catch (e) { d = null; }
    if (!el.isConnected) return;
    const lw = app.querySelector('[data-lw="' + id + '"]');
    const sn = app.querySelector('[data-stale="' + id + '"]');
    if (sn) { const note = staleNote(d, g); sn.hidden = !note; sn.textContent = note; const tag = app.querySelector('.game-hero .tag'); if (tag && note && !g.unfinal) tag.textContent = 'NO UPDATES'; }
    const pe = app.querySelector('[data-plays="' + id + '"]');
    if (pe) { if (d) renderPlays(pe, d, g, view(g)); else pe.hidden = true; }
    if (d) { renderFouls(el, d, g, view(g)); if (lw) renderLiveWorm(lw, d, g, view(g)); if (g.status === 'live') scoreMoments(g, d); } else if (lw) lw.hidden = true;
    if (g.status === 'live') { clearTimeout(hydrateFouls.t); hydrateFouls.t = setTimeout(() => { if (el.isConnected && !document.hidden) hydrateFouls(el); }, 30e3); }
  }
  // Live worm: the scraper's flow is the running score after each scoring play, [[quarter, team1, team2], ...].
  function renderLiveWorm(el, d, g, v) {
    const flow = (d.flow || []).filter((f) => Array.isArray(f) && f.length >= 3);
    if (!flow.length) { el.hidden = true; return; }
    const live = g.status === 'live';
    const m = (f) => (v.home ? f[1] - f[2] : f[2] - f[1]);
    const curQ = Math.max(d.quarter || 1, flow[flow.length - 1][0]);
    const nQ = Math.max(4, curQ);
    const perQ = (q) => flow.filter((f) => f[0] === q).length;
    const done = []; for (let q = 1; q < curQ; q++) done.push(perQ(q));
    const avg = done.length ? done.reduce((a, b) => a + b, 0) / done.length : 12;
    const curFrac = live ? Math.min(0.92, Math.max(0.12, (perQ(curQ) + 0.5) / Math.max(avg, 1))) : 1;
    const W = 600, H = 120, mid = H / 2;
    const pts = [[0, 0]];
    let best = 0, worst = 0, changes = 0, prev = 0, run = { n: 0, who: 0, q: 0 }, cr = { n: 0, who: 0 }, last = [0, 0, 0];
    for (let q = 1; q <= curQ; q++) {
      const e = flow.filter((f) => f[0] === q);
      const span = q === curQ ? curFrac : 1;
      e.forEach((f, i) => {
        const x = ((q - 1) + span * (q === curQ && live ? (i + 1) / e.length : (i + 1) / (e.length + 0.5))) / nQ * W;
        const mm = m(f);
        pts.push([x, mm]);
        best = Math.max(best, mm); worst = Math.min(worst, mm);
        if (mm && prev && Math.sign(mm) !== Math.sign(prev)) changes++;
        if (mm) prev = mm;
        const du = (v.home ? f[1] - last[1] : f[2] - last[2]), dt = (v.home ? f[2] - last[2] : f[1] - last[1]);
        const who = du > 0 ? 1 : dt > 0 ? -1 : 0, n = Math.max(du, dt);
        if (who) { if (who === cr.who) cr.n += n; else cr = { n, who }; if (cr.n > run.n) run = { n: cr.n, who, q }; }
        last = f;
      });
    }
    const nowX = live ? ((curQ - 1) + curFrac) / nQ * W : W;
    const cur = m(flow[flow.length - 1]);
    pts.push([nowX, cur]);
    const R = Math.max(10, best, -worst);
    const y = (mm) => mid - mm / R * (mid - 10);
    let path = 'M0,' + mid;
    pts.forEach(([x, mm], i) => { if (i) path += 'H' + x.toFixed(1) + 'V' + y(mm).toFixed(1); });
    const area = path + 'V' + mid + 'Z';
    const usName = v.us.short, themName = v.them ? (v.them.ours ? v.them.short : v.them.club) : '';
    const sid = 'lw' + g.id;
    const lbl = cur > 0 ? '+' + cur : cur < 0 ? String(cur) : 'Level';
    const lx = Math.min(nowX + 10, W - 50);
    const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Margin through the game, ' + usName + ' ' + lbl) + '">' +
      '<defs><clipPath id="' + sid + 'u"><rect x="0" y="0" width="' + W + '" height="' + mid + '"/></clipPath><clipPath id="' + sid + 'd"><rect x="0" y="' + mid + '" width="' + W + '" height="' + mid + '"/></clipPath></defs>' +
      (live ? '<rect x="' + nowX.toFixed(1) + '" y="0" width="' + (W - nowX).toFixed(1) + '" height="' + H + '" fill="rgba(255,255,255,.05)"/>' : '') +
      Array.from({ length: nQ - 1 }, (_, i) => '<line x1="' + ((i + 1) * W / nQ).toFixed(1) + '" x2="' + ((i + 1) * W / nQ).toFixed(1) + '" y1="0" y2="' + H + '" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 4"/>').join('') +
      '<line x1="0" x2="' + W + '" y1="' + mid + '" y2="' + mid + '" stroke="rgba(255,255,255,.35)"/>' +
      '<path d="' + area + '" fill="var(--red)" fill-opacity=".3" clip-path="url(#' + sid + 'u)"/><path d="' + area + '" fill="rgba(255,255,255,.14)" clip-path="url(#' + sid + 'd)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linejoin="round"/>' +
      (live ? '<circle class="lw-pulse" cx="' + nowX.toFixed(1) + '" cy="' + y(cur).toFixed(1) + '" r="4" fill="none" stroke="var(--red)" stroke-width="2"/>' +
        '<circle cx="' + nowX.toFixed(1) + '" cy="' + y(cur).toFixed(1) + '" r="5" fill="var(--red)" stroke="var(--navy)" stroke-width="2"/>' +
        '<text x="' + lx.toFixed(1) + '" y="' + (y(cur) + 5).toFixed(1) + '" class="lw-now">' + esc(lbl) + '</text>' : '') +
      '<text x="4" y="14" class="lw-side">' + esc(usName) + ' ahead</text><text x="4" y="' + (H - 4) + '" class="lw-side">' + esc(themName) + ' ahead</text></svg>';
    const chips = [];
    if (best > 0) chips.push('Biggest lead +' + best);
    if (worst < 0) chips.push(themName + ' led by ' + (-worst));
    if (changes) chips.push(changes + ' lead change' + (changes === 1 ? '' : 's'));
    if (run.n >= 6) chips.push((run.who > 0 ? usName : themName) + ' ' + run.n + '–0 run in ' + (run.q > 4 ? 'OT' : 'Q' + run.q));
    el.hidden = false;
    el.innerHTML = svg + '<div class="lw-q" style="grid-template-columns:repeat(' + nQ + ',1fr)">' + Array.from({ length: nQ }, (_, i) => '<span' + (live && i + 1 === curQ ? ' class="on"' : '') + '>' + (i >= 4 ? 'OT' : 'Q' + (i + 1)) + '</span>').join('') + '</div>' +
      (chips.length ? '<div class="lw-foot">' + chips.map((c) => '<span>' + esc(c) + '</span>').join('') + '</div>' : '');
  }
  function renderFouls(el, d, g, v) {
    const ourSide = v.home ? 'team1' : 'team2', theirSide = v.home ? 'team2' : 'team1';
    const players = d.players || {}, tf = d.teamFouls || {};
    const q = d.quarter || Math.max(1, (tf.team1 || []).length, (tf.team2 || []).length);
    const qLabel = q > 4 ? 'OT' : 'Q' + q;
    const usName = v.us.short, themName = v.them ? (v.them.ours ? v.them.short : v.them.club) : '';
    const pips = (n, max, cls) => '<span class="fpips' + (cls ? ' ' + cls : '') + '">' + Array.from({ length: max }, (_, i) => '<i' + (i < n ? ' class="on"' : '') + '></i>').join('') + '</span>';
    const teamBox = (side, name) => {
      const n = (tf[side] || [])[q - 1] || 0;
      const pen = n >= 4;
      return '<div class="ft-team' + (pen ? ' pen' : '') + '"><span class="ft-name">' + esc(name) + '</span>' + pips(Math.min(n, 4), 4) +
        '<b>' + n + '</b><span class="ft-note">' + (pen ? 'In the penalty: fouls now give free throws' : (4 - n) + ' to the penalty') + '</span></div>';
    };
    const list = (side, name, mine) => {
      const rows = (players[side] || []).filter((p) => p.fouls > 0).sort((a, b) => b.fouls - a.fouls || num(a.no) - num(b.no));
      return '<div class="fl-team"><h4>' + esc(name) + '</h4>' + (rows.length ? rows.map((p) => {
        const st = p.fouls >= 5 ? 'out' : p.fouls === 4 ? 'warn' : '';
        return '<div class="fl-row ' + st + '"><span class="fl-no">' + esc(p.no) + '</span><span class="fl-name">' + esc(/^hidden player$/i.test(p.player || '') ? 'Player #' + p.no : (p.player || '')) + '</span>' +
          pips(Math.min(p.fouls, 5), 5) + '<span class="fl-tag">' + (st === 'out' ? 'Out' : st === 'warn' ? 'On 4' : p.fouls) + '</span></div>';
      }).join('') : '<div class="fl-none">No fouls yet</div>') + '</div>';
    };
    const upd = d.updatedAt ? time(new Date(d.updatedAt)) : '';
    el.hidden = false;
    el.innerHTML = '<div class="card-head"><h3>' + (g.status === 'live' ? '<span class="alog-dot"></span>Live fouls' : 'Fouls') + '</h3><span class="meta">' + esc((g.status === 'live' ? qLabel + ' · ' : '') + (upd ? 'updated ' + upd : '')) + '</span></div>' +
      (g.status === 'live' ? '<div class="ft-grid">' + teamBox(ourSide, usName) + teamBox(theirSide, themName) + '</div>' : '') +
      '<div class="fl-grid">' + list(ourSide, usName, true) + list(theirSide, themName, false) + '</div>' +
      '<p class="fine">From BasketballConnect\'s live action log. Team fouls reset each quarter.</p>';
  }

  // A live game the scorer has stopped entering. The scraper publishes status 'stale' and changedAt (when the action log last changed).
  function staleNote(d, g) {
    if (!d || g.status !== 'live') return '';
    const at = Date.parse(d.changedAt) || 0;
    if (d.status !== 'stale' && !(at && Date.now() - at > 20 * 60e3)) return '';
    return 'No updates ' + (at ? 'since ' + time(new Date(at)) : 'for a while') + '. The scorer may have stopped entering this game.';
  }
  /* ---------- play by play (from the scraper's `plays` list) ---------- */
  // <foulsBase>/match-<id>.json may carry  plays: [{ q, clock, side: 'team1'|'team2', no, player, type, pts, text, score: [team1, team2] }]
  // oldest first. type is '2pt' | '3pt' | 'ft' | 'foul' | 'timeout' | anything else. Without plays the tab stays hidden.
  const ppState = {}, ppSeen = {}, ppRead = {};
  const PP_LABEL = { '2pt': '2 pointer', '3pt': '3 pointer', ft: 'Free throw', foul: 'Foul', timeout: 'Timeout' };
  function renderPlays(el, d, g, v) {
    const all = (Array.isArray(d.plays) ? d.plays : []).filter((p) => p && p.type);
    if (!all.length) { el.hidden = true; return; }
    const wasHidden = el.hidden;
    const st = ppState[g.id] || (ppState[g.id] = { open: false, filter: 'all', q: {} });
    const rows = all.slice().reverse(); // newest first
    const total = rows.length;
    const fresh = ppSeen[g.id] != null && total > ppSeen[g.id] ? total - ppSeen[g.id] : 0;
    ppSeen[g.id] = total;
    if (ppRead[g.id] == null) ppRead[g.id] = total;
    const usName = v.us.short, themName = v.them ? (v.them.ours ? v.them.short : v.them.club) : '';
    const live = g.status === 'live';
    const mineOf = (p) => (p.side === 'team1') === !!v.home;
    const qLab = (q) => (q > 4 ? 'OT' : 'Q' + q);
    const row = (p, i, noQ) => {
      const mine = mineOf(p);
      const nm = !p.player || /^hidden player$/i.test(p.player) ? '' : ' ' + p.player;
      const who = p.no != null && p.no !== '' ? '#' + p.no + nm : (mine ? usName : themName);
      const kind = p.type === 'foul' ? 'ff' : p.type === 'timeout' ? 'to' : mine ? 'p' : 'po';
      const badge = p.type === 'foul' ? 'F' : p.type === 'timeout' ? 'T/O' : '+' + (p.pts || (p.type === '3pt' ? 3 : p.type === 'ft' ? 1 : 2));
      const sc = Array.isArray(p.score) && p.score.length >= 2 ? (v.home ? p.score[0] + '–' + p.score[1] : p.score[1] + '–' + p.score[0]) : '';
      const sub = (mine ? '' : themName + ' · ') + (PP_LABEL[p.type] || p.text || 'Play');
      return '<div class="pp-row' + (i < fresh ? ' fresh' : '') + (mine ? '' : ' opp') + '"><span class="pp-t">' + esc(qLab(p.q || 1)) + '<br>' + esc(p.clock || '') + '</span><span class="pp-bar"></span>' +
        '<span class="pp-x">' + esc(who) + '<small>' + esc(sub) + '</small></span><span class="pp-k ' + kind + '">' + badge + '</span><span class="pp-sc">' + esc(sc) + '</span></div>';
    };
    const filters = [['all', 'All'], ['scores', 'Scores'], ['fouls', 'Fouls'], ['ours', usName + ' only']];
    const keep = (p) => st.filter === 'scores' ? /^(2pt|3pt|ft)$/.test(p.type) : st.filter === 'fouls' ? p.type === 'foul' : st.filter === 'ours' ? mineOf(p) : true;
    let body;
    if (!st.open) {
      body = rows.slice(0, 3).map(row).join('') + '<button type="button" class="pp-more" data-pp-act="open">Show all plays (' + total + ') ▾</button>';
    } else {
      const list = rows.filter(keep), groups = [];
      list.forEach((p) => { const last = groups[groups.length - 1]; if (last && last.q === (p.q || 1)) last.rows.push(p); else groups.push({ q: p.q || 1, rows: [p] }); });
      let n = 0;
      body = '<div class="pp-chips">' + filters.map((f) => '<button type="button" class="pp-chip" aria-pressed="' + (st.filter === f[0]) + '" data-pp-filter="' + f[0] + '">' + esc(f[1]) + '</button>').join('') + '</div>' +
        (groups.length ? groups.map((gr, i) => {
          const html = gr.rows.map((p) => row(p, n++, true)).join('');
          return i === 0 ? '<div class="pp-q">' + qLab(gr.q) + '</div>' + html
            : '<details class="pp-qd" data-q="' + gr.q + '"' + (st.q[gr.q] ? ' open' : '') + '><summary><b>' + qLab(gr.q) + '</b><span>' + gr.rows.length + (gr.rows.length === 1 ? ' play' : ' plays') + '</span></summary>' + html + '</details>';
        }).join('') : '<div class="fl-none">No plays match this filter.</div>') +
        '<button type="button" class="pp-more" data-pp-act="close">Show less ▴</button>';
    }
    el.hidden = false;
    el.innerHTML = '<div class="card-head"><h3>' + (live ? '<span class="alog-dot"></span>' : '') + 'Play by play</h3><span class="meta">' + (live ? 'Live · ' : '') + 'newest first</span></div>' + body +
      '<p class="fine">From BasketballConnect\'s live action log, updated about every 30 seconds.</p>';
    el.onclick = (e) => {
      const t = e.target.closest('[data-pp-act], [data-pp-filter], summary');
      if (!t) return;
      if (t.tagName === 'SUMMARY') { const dt = t.parentNode; st.q[dt.dataset.q] = !dt.open; return; }
      if (t.dataset.ppAct) st.open = t.dataset.ppAct === 'open'; else st.filter = t.dataset.ppFilter;
      renderPlays(el, d, g, v);
    };
    const w = el.closest('.pp');
    if (w && wasHidden && store.get('lions.ppTab') === 'fouls') requestAnimationFrame(() => { const tr = w.querySelector('.pp-track'); tr.scrollLeft = tr.scrollWidth; });
    if (w && w._ppSync) w._ppSync();
  }
  // Tabs + swipe: Play by play first, Live fouls second. The tab you last used is remembered.
  function setupPP(w, restoreX) {
    if (!w || w.dataset.ready) return;
    w.dataset.ready = '1';
    const track = w.querySelector('.pp-track'), tabs = [...w.querySelectorAll('[data-pp-tab]')], dots = [...w.querySelectorAll('.pp-dots button')], ind = w.querySelector('.pp-ind');
    const badge = tabs[0].querySelector('em'), id = w.dataset.pp;
    let userAt = 0, idx = 0;
    const sync = () => {
      const max = track.scrollWidth - track.clientWidth;
      idx = max > 4 && track.scrollLeft >= max / 2 ? 1 : 0;
      tabs.forEach((b, j) => { b.classList.toggle('on', j === idx); b.setAttribute('aria-selected', j === idx); });
      dots.forEach((b, j) => b.classList.toggle('on', j === idx));
      ind.style.transform = 'translateX(' + idx * 100 + '%)';
      if (idx === 0) ppRead[id] = ppSeen[id];
      const n = (ppSeen[id] || 0) - (ppRead[id] || 0);
      badge.hidden = !(idx === 1 && n > 0); badge.textContent = n + ' new';
      if (Date.now() - userAt < 1500) store.set('lions.ppTab', idx ? 'fouls' : 'plays');
    };
    w._ppSync = sync;
    track.addEventListener('scroll', () => { cancelAnimationFrame(sync.f); sync.f = requestAnimationFrame(sync); }, { passive: true });
    ['touchstart', 'pointerdown', 'wheel', 'keydown'].forEach((ev) => track.addEventListener(ev, () => { userAt = Date.now(); }, { passive: true }));
    tabs.forEach((b, j) => b.addEventListener('click', () => { userAt = Date.now(); track.scrollTo({ left: j ? track.scrollWidth : 0, behavior: 'smooth' }); }));
    if (restoreX != null) track.scrollLeft = restoreX;
    sync();
  }

  /* ---------- sortable stat tables ---------- */
  // Tap a column header to sort; tap again to flip. The choice is kept while the page refreshes.
  const sorts = {};
  const sortKey = (table) => location.hash + '|' + [...app.querySelectorAll('table.sortable')].indexOf(table);
  function sortTable(table, col, dir) {
    const tb = table.tBodies[0];
    const rows = [...tb.rows];
    if (!rows.length || rows[0].querySelector('.empty')) return;
    const val = (r) => { const s = (r.cells[col] ? r.cells[col].textContent : '').trim(); const n = parseFloat(s); return isNaN(n) ? s.toLowerCase() : n; };
    const numeric = rows.some((r) => typeof val(r) === 'number');
    rows.sort((a, b) => {
      let x = val(a), y = val(b);
      if (numeric) { x = typeof x === 'number' ? x : -Infinity; y = typeof y === 'number' ? y : -Infinity; }
      const c = x < y ? -1 : x > y ? 1 : 0;
      return dir === 'asc' ? c : -c;
    });
    rows.forEach((r) => tb.appendChild(r));
    [...table.tHead.rows[0].cells].forEach((th, i) => {
      th.setAttribute('aria-sort', i === col ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }
  function applySorts(root) {
    root.querySelectorAll('table.sortable').forEach((table) => {
      const ths = [...table.tHead.rows[0].cells];
      ths.forEach((th) => { th.tabIndex = 0; th.setAttribute('role', 'button'); });
      const s = sorts[sortKey(table)];
      if (s) sortTable(table, s.col, s.dir);
      else { const i = ths.findIndex((th) => th.textContent === 'PTS'); if (i >= 0) ths[i].setAttribute('aria-sort', 'descending'); }
    });
  }
  function onSortHeader(e) {
    const th = e.target.closest && e.target.closest('table.sortable thead th');
    if (!th || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const table = th.closest('table'), col = th.cellIndex, key = sortKey(table);
    const cur = th.getAttribute('aria-sort');
    const textCol = th.textContent === 'Player';
    const dir = cur === 'descending' ? 'asc' : cur === 'ascending' ? 'desc' : textCol || th.textContent === '#' ? 'asc' : 'desc';
    sorts[key] = { col, dir };
    sortTable(table, col, dir);
  }
  app.addEventListener('click', onSortHeader);
  app.addEventListener('keydown', onSortHeader);

  /* ---------- add to home screen ---------- */
  // Android/desktop Chrome hand us an install prompt; iPhone needs the Share > Add to Home Screen steps.
  const SITE_NAME = 'Lions Den';
  const STORE_A2HS = 'lions.a2hsLater';
  let installPrompt = null;
  const isAndroid = () => /Android/i.test(navigator.userAgent);
  // Facebook, Messenger and Instagram open links in their own in-app browser, which can't add to home screen.
  const inAppName = () => { const ua = navigator.userAgent; if (/Messenger/i.test(ua)) return 'Messenger'; if (/Instagram/i.test(ua)) return 'Instagram'; if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i.test(ua)) return 'Facebook'; return ''; };
  const browserName = () => isIOS() ? 'Safari' : 'Chrome';
  const COMPASS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M15.5 8.5l-2 5-5 2 2-5z"></path></svg>';
  const COPY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>';
  function openInBrowser() {
    const url = location.origin + location.pathname;
    if (isAndroid()) {
      location.href = 'intent://' + location.host + location.pathname + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
    } else {
      location.href = 'x-safari-' + location.href; // iOS 17+ opens this in Safari; older versions ignore it
    }
  }
  async function copyLink() {
    const url = location.origin + location.pathname;
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (err) {
      const ta = document.createElement('textarea'); ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    toast(ok ? '<span>Link copied. Open ' + browserName() + ' and paste it in the address bar.</span>' : '<span>Couldn\'t copy. The link is ' + esc(url) + '</span>');
  }
  function installBanner() {
    if (isStandalone()) return '';
    const later = parseInt(store.get(STORE_A2HS) || '0', 10);
    if (later && Date.now() - later < 30 * 864e5) return '';
    if (!installPrompt && !isIOS() && !isAndroid()) return '';
    const phone = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"></rect><path d="M11 18h2"></path></svg>';
    return '<section class="a2hs" aria-label="Add to home screen"><div class="a2hs-top"><img src="icon-192.png" alt="" width="56" height="56"><div><h2>' + esc(SITE_NAME) + ' on your phone</h2>' +
      '<p>Scores, fixtures and venues one tap away, just like an app.</p></div></div>' +
      '<button class="a2hs-go" type="button" data-install>' + (inAppName() ? COMPASS + 'Open in ' + browserName() : phone + 'Add to home screen') + '</button>' +
      '<button class="a2hs-later" type="button" data-install-later>Not now</button></section>';
  }
  function installSheet() {
    const share = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="M7 8l5-5 5 5"></path><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path></svg>';
    const plus = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="M12 8v8M8 12h8"></path></svg>';
    const steps = isIOS()
      ? ['Tap the <b>Share</b> button ' + share + ' in the browser toolbar', 'Scroll down and choose <b>Add to Home Screen</b> ' + plus, 'Tap <b>Add</b> in the top corner']
      : ['Tap the browser menu <b>⋮</b> in the top corner', 'Choose <b>Add to Home screen</b> or <b>Install app</b>', 'Tap <b>Add</b> or <b>Install</b>'];
    const app2 = inAppName();
    const el = document.createElement('div');
    el.className = 'a2hs-sheet-wrap';
    if (app2) {
      const b = browserName();
      el.innerHTML = '<div class="a2hs-sheet-bg" data-sheet-close></div><div class="a2hs-sheet" role="dialog" aria-modal="true" aria-label="Open in ' + b + '"><div class="a2hs-grab"></div>' +
        '<div class="a2hs-sheet-hd"><img src="icon-192.png" alt="" width="52" height="52"><div><h2>Open in ' + b + ' first</h2><span>' + app2 + '\'s browser can\'t add apps to your home screen</span></div></div>' +
        '<button class="a2hs-open" type="button" data-open-browser>' + COMPASS + 'Open in ' + b + '</button>' +
        '<button class="a2hs-copy" type="button" data-copy-link>' + COPY + 'Copy link</button>' +
        '<div class="a2hs-or">Nothing happened? Use one of these:</div>' +
        '<div class="a2hs-step"><b>1</b><span>Tap <b>•••</b> in the top corner, then <b>Open in ' + (isIOS() ? 'Safari' : 'Chrome</b> or <b>Open in browser') + '</b></span></div>' +
        '<div class="a2hs-step"><b>2</b><span>Or open ' + b + ' and <b>paste</b> the copied link</span></div>' +
        '<div class="a2hs-or">Then tap <b>Add to home screen</b> again in ' + b + '.</div>' +
        '<button class="a2hs-done" type="button" data-sheet-close>Close</button></div>';
      document.body.appendChild(el);
      el.querySelector('.a2hs-open').focus();
      return;
    }
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
    const t = e.target.closest('[data-install], [data-install-later], [data-sheet-close], [data-open-browser], [data-copy-link]');
    if (!t) return;
    if (t.hasAttribute('data-open-browser')) { openInBrowser(); return; }
    if (t.hasAttribute('data-copy-link')) { copyLink(); return; }
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
  const HYDRATED = '[data-tick], [data-lw], [data-fouls], [data-plays], [data-flow], [data-worm], [data-game-stats], [data-ladder], [data-finals], [data-team-stats]';
  const hydKey = (el) => ['tick', 'lw', 'fouls', 'plays', 'flow', 'worm', 'gameStats', 'ladder', 'finals', 'teamStats'].map((a) => el.dataset[a] != null ? a + el.dataset[a] : '').join('');
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
    // On a refresh of the same page, keep cards that already loaded so they update in place
    // instead of flashing back to "Loading…" (and keep the swiped-to card).
    const sig = h + '|' + (parts[0] === 'game' ? ((DATA.games.find((x) => x.id === parseInt(parts[1], 10)) || {}).status || '') : '');
    const same = route.sig === sig;
    const kept = new Map(), present = new Set();
    let swipeX = 0, ppX = null;
    if (same) {
      app.querySelectorAll(HYDRATED).forEach((el) => {
        const k = hydKey(el); present.add(k);
        if (!el.querySelector(':scope > .loading')) kept.set(k, { html: el.innerHTML, hidden: el.hidden });
      });
      const tr = app.querySelector('.swipe-track'); if (tr) swipeX = tr.scrollLeft;
      const pt = app.querySelector('.pp-track'); if (pt) ppX = pt.scrollLeft;
    }
    app.innerHTML = html;
    if (same) {
      app.querySelectorAll(HYDRATED).forEach((el) => {
        const k = hydKey(el), was = kept.get(k);
        if (was) { el.innerHTML = was.html; el.hidden = was.hidden; }
        else if (!present.has(k)) { const box = el.closest('.swipe, [data-ladder-wrap]') || el; box.remove(); } // it had no data last time
      });
      const tr = app.querySelector('.swipe-track');
      if (tr && swipeX) { tr.scrollLeft = swipeX; tr.dispatchEvent(new Event('scroll')); }
    }
    app.querySelectorAll('.pp').forEach((w) => setupPP(w, same ? ppX : null));
    route.sig = sig;
    playSirens();
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    const strip = document.getElementById('sponsor-strip');
    if (strip) strip.hidden = !(nav === 'home' && strip.innerHTML);
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
    if (b.dataset.bell != null) {
      b.disabled = true;
      toggleBell(parseInt(b.dataset.bell, 10))
        .then(() => route())
        .catch((err) => { b.disabled = false; toast('<span>Couldn\'t change alerts: ' + esc(err.message) + '</span>'); });
      return;
    }
    if (b.dataset.star != null) {
      const id = parseInt(b.dataset.star, 10);
      const ids = myTeamIds();
      const nextIds = ids.includes(id) ? ids.filter((v) => v !== id) : ids.concat(id);
      store.set(STORE_MY_TEAM, nextIds.length ? nextIds.join(',') : null);
      if (!nextIds.includes(id) && bellIds().includes(id)) {
        const rest = bellIds().filter((v) => v !== id); setBellIds(rest);
        (rest.length ? syncAlerts() : disableAlerts()).catch(() => {});
      }
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
      // Unfinalised games are left out, so no siren plays when one is finally ended hours later.
      const wasLive = new Set(DATA ? DATA.games.filter((g) => g.status === 'live' && !g.unfinal).map((g) => g.id) : []);
      DATA = normalise(await fetchAll());
      DATA.games.forEach((g) => { if (wasLive.has(g.id) && g.status === 'final' && !justFinal.has(g.id)) { justFinal.set(g.id, Date.now()); sirenQueue.add(g.id); } });
      // Opened by tapping a full-time alert: play the siren for that game once, as if you had watched it finish.
      if (fromAlert) {
        fromAlert = false;
        const m = (location.hash || '').match(/^#\/game\/(\d+)/);
        const g = m && DATA.games.find((x) => x.id === parseInt(m[1], 10));
        if (g && g.status === 'final' && Date.now() - g.start.getTime() < 5 * 3600e3) { justFinal.set(g.id, Date.now()); sirenQueue.add(g.id); }
        try { const u = new URL(location.href); u.searchParams.delete('from'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) { /* fine */ }
      }
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
    const anyLive = DATA && DATA.games.some((g) => g.status === 'live' && !g.unfinal);
    const soon = DATA && DATA.games.some((g) => g.status === 'upcoming' && !g.postponed && Math.abs(g.start - Date.now()) < 3600e3);
    refreshTimer = setTimeout(() => { if (!document.hidden) load(true); else refreshTimer = null; }, anyLive || soon ? CFG.liveRefreshMs : 10 * 60e3);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !refreshTimer) load(true); });

  document.getElementById('season-label').textContent = 'Central Districts Basketball · ' + CFG.seasonLabel;
  document.getElementById('source-link').href = CFG.competitions[0].sourceUrl;
  renderSponsorFrame();
  load(false);
})();
