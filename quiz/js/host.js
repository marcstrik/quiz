/* Liryc Quiz – écran animateur (à partager dans Zoom) */
(() => {
  'use strict';
  const { api, syncClock, el, fmt, ordinal, store, confetti, rules, LETTERS } = LQ;
  const stage = document.getElementById('stage');
  const PIN_KEY = 'lq-host-pin';
  const BASE = location.href.replace(/[?#].*$/, '').replace(/host\.html$/, '');
  const SHORT = BASE.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const H = {
    pin: null, quiz: null, st: null, offset: 0, view: '', refs: {},
    busy: false, closeSent: {}, timer: null, chips: new Map(),
    big: store.get('lq-host-big') === 1, // « Masquer le texte » : l'image de la question prend tout l'écran
    review: null, // { list: [indices des questions corrigées], data: [...], k: position } pendant « Revoir les questions »
  };
  const now = () => Date.now() + H.offset;
  const game = () => H.st.game;
  const players = () => H.st.players; // [pub, name, score, lastPts, lastOk, nbJustes] triés par rang

  // ------------------------------------------------------------ hors partie
  const logo = () => el('img', { class: 'logo', src: 'img/logo.png', alt: 'Live Quiz' });
  const underline = () => el('div', { class: 'underline' });

  function panel(...kids) {
    H.view = 'panel';
    stage.replaceChildren(el('div', { class: 'host-panel' },
      el('div', { class: 'h-top' }, logo(), el('span', { class: 'pill', text: 'Quiz · animateur' })),
      el('div', { class: 'wrap' }, el('div', { class: 'card' }, ...kids))));
  }

  function loginScreen(msg) {
    const pw = el('input', { class: 'field', type: 'password', placeholder: 'Mot de passe animateur', autocomplete: 'current-password' });
    const err = el('p', { class: 'error', text: msg || '' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Se connecter' });
    panel(el('form', {
      style: 'display:flex;flex-direction:column;gap:12px',
      onsubmit: async e => {
        e.preventDefault();
        btn.disabled = true;
        try { await api('login', { password: pw.value }); setupScreen(); } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      },
    }, el('h1', { text: 'Live Quiz – Animateur' }), el('p', { text: 'Connectez-vous pour lancer une partie.' }), pw, btn, err));
    pw.focus();
  }

  async function setupScreen() {
    stopLoop();
    let quizzes = [];
    try { quizzes = (await api('quizzes')).quizzes; } catch (e) { if (e.status === 401) return loginScreen(); }
    const saved = store.get(PIN_KEY);
    let resume = null;
    if (saved) {
      try {
        const j = await api('host_state', null, { pin: saved, full: 1 });
        if (j.game.phase !== 'end') resume = j;
      } catch (e) { store.del(PIN_KEY); }
    }
    const err = el('p', { class: 'error' });
    panel(
      el('h1', { text: 'Nouvelle partie' }),
      el('p', { text: 'Choisissez le quiz : il devient la partie que rejoignent les participants sur la page du quiz.' }),
      el('div', { class: 'quiz-pick' }, quizzes.map(q => el('button', {
        type: 'button',
        onclick: async () => {
          try { begin(await api('host', { op: 'create', quiz: q.id })); } catch (e) { err.textContent = e.message; }
        },
      }, q.title, el('small', { text: q.n + ' questions' })))),
      resume && el('button', { class: 'btn ghost', type: 'button', onclick: () => begin(resume, true) },
        `Reprendre la partie en cours (${resume.quiz.title}, ${resume.players.length} joueur${resume.players.length > 1 ? 's' : ''})`),
      resume && el('button', {
        class: 'btn ghost', type: 'button', text: 'Terminer cette partie',
        onclick: async () => {
          if (!confirm(`Terminer la partie « ${resume.quiz.title} » ? Les participants verront le classement final.`)) return;
          try { await api('host', { op: 'abort', pin: resume.game.pin }); store.del(PIN_KEY); setupScreen(); } catch (e) { err.textContent = e.message; }
        },
      }),
      el('p', { style: 'margin:4px 0 0;font-size:14px' }, el('a', { href: 'guide.html', target: '_blank', text: 'Créer un nouveau quiz avec Claude →' })),
      err);
  }

  async function begin(j, resumed) {
    H.pin = j.game.pin;
    H.quiz = j.quiz;
    H.closeSent = {};
    H.view = '';
    store.set(PIN_KEY, H.pin);
    try { H.offset = await syncClock(); } catch (e) { /* horloge locale */ }
    apply(j);
    if (resumed) op('activate'); // redevient la partie que rejoignent les téléphones
    loop();
  }

  // ------------------------------------------------------------ boucle
  function stopLoop() { clearTimeout(H.timer); H.pin = null; H.st = null; }

  async function loop() {
    clearTimeout(H.timer);
    if (!H.pin) return;
    try {
      apply(await api('host_state', null, { pin: H.pin, full: H.quiz ? 0 : 1 }));
    } catch (e) {
      if (e.status === 401) { stopLoop(); return loginScreen('Session expirée, reconnectez-vous.'); }
    }
    if (H.pin) H.timer = setTimeout(loop, 1000);
  }

  function apply(j) {
    if (j.quiz) H.quiz = j.quiz;
    H.st = j;
    render();
  }

  async function op(name, extra) {
    if (H.busy || !H.pin) return;
    H.busy = true;
    try { apply(await api('host', Object.assign({ op: name, pin: H.pin }, extra || {}))); } catch (e) { flash(e.message); } finally { H.busy = false; }
  }

  function flash(msg) {
    const n = el('div', { class: 'net', text: msg });
    document.body.append(n);
    setTimeout(() => n.remove(), 4000);
  }

  // ------------------------------------------------------------ rendu
  function show(key, build) {
    if (H.view === key) return false;
    H.view = key;
    H.refs = {};
    stage.replaceChildren(build());
    return true;
  }

  function render() {
    const g = game();
    if (!['question', 'reveal'].includes(g.phase) && !H.review) stage.classList.remove('bigimg');
    if (H.review) {
      if (g.phase === 'end') return show('review' + H.review.k, reviewView);
      H.review = null;
    }
    switch (g.phase) {
      case 'lobby': show('lobby', lobbyView); return updateLobby();
      case 'question': return questionPhase();
      case 'reveal': return show('reveal' + g.qi, () => qView(true));
      case 'scores': return show('scores' + g.qi, scoresView);
      case 'podium': show('podium', podiumView); return updatePodium();
      case 'end': if (show('end', endView)) fit(H.refs.ranking, 1.35, 0.6); return;
    }
  }

  function questionPhase() {
    const g = game();
    if (now() < g.started) show('ready' + g.qi, readyView);
    else { show('q' + g.qi, () => qView(false)); updateQuestion(); }
  }

  setInterval(() => {
    if (!H.st) return;
    const g = game();
    if (g.phase !== 'question') return;
    questionPhase();
    const t = now();
    if (H.refs.count) H.refs.count.textContent = Math.max(1, Math.ceil((g.started - t) / 1000));
    if (H.refs.ring) {
      const total = g.ends - g.started, left = Math.max(0, g.ends - t);
      H.refs.ringFg.style.strokeDashoffset = String(CIRC * (1 - left / total));
      H.refs.ringTxt.textContent = Math.ceil(left / 1000);
      H.refs.ring.classList.toggle('low', left < 10000);
    }
    // Clôture automatique : temps écoulé, ou tout le monde a répondu.
    const active = players().length;
    if (!H.busy && !H.closeSent[g.qi] && t > g.started &&
        (t > g.ends + 800 || (active > 0 && H.st.answered >= active))) {
      H.closeSent[g.qi] = true;
      op('close');
    }
  }, 200);

  document.addEventListener('keydown', e => {
    if (e.target.matches && e.target.matches('input, textarea')) return;
    if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
    if ((e.key === 'm' || e.key === 'M') && H.refs.bigBtn) { H.refs.bigBtn.click(); return; }
    if ((e.key === 'e' || e.key === 'E') && H.refs.exBtn) { H.refs.exBtn.click(); return; }
    if (['ArrowLeft', 'PageUp'].includes(e.key) && H.refs.prev && !H.refs.prev.disabled) {
      e.preventDefault();
      H.refs.prev.click();
      return;
    }
    if ([' ', 'Enter', 'ArrowRight', 'PageDown'].includes(e.key) && H.refs.primary && !H.refs.primary.disabled) {
      e.preventDefault();
      H.refs.primary.click();
    }
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  // Bouton « Masquer le texte » / « Afficher le texte » (touche M), gardé d'une question à l'autre.
  function bigButton() {
    const label = () => (H.big ? 'Afficher le texte' : 'Masquer le texte');
    stage.classList.toggle('bigimg', H.big);
    H.refs.bigBtn = el('button', {
      class: 'btn ghost', type: 'button', title: 'Agrandir l’image en masquant la question et les réponses (touche M)', text: label(),
      onclick: e => {
        H.big = !H.big;
        store.set('lq-host-big', H.big ? 1 : 0);
        stage.classList.toggle('bigimg', H.big);
        e.currentTarget.textContent = label();
      },
    });
    return H.refs.bigBtn;
  }

  function abortGame() {
    if (!confirm('Terminer la partie maintenant ? Les participants verront le classement final.')) return;
    stage.classList.remove('bigimg');
    H.closeSent[game().qi] = true; // pas de clôture automatique pendant la fin
    op('abort');
  }

  function controls(hint, ...buttons) {
    const live = H.st && game().phase !== 'end';
    return el('div', { class: 'controls' },
      hint && el('span', { class: 'hint', text: hint }),
      live && el('button', { class: 'btn ghost', type: 'button', title: 'Terminer la partie maintenant', text: '✕ Terminer', onclick: abortGame }),
      el('button', { class: 'btn ghost', type: 'button', title: 'Plein écran (touche F)', text: '⛶', onclick: toggleFullscreen }),
      ...buttons);
  }

  function primary(text, onclick) {
    H.refs.primary = el('button', { class: 'btn', type: 'button', text, onclick });
    return H.refs.primary;
  }

  // Bandeau Liryc Education : logo à gauche, informations de la partie à droite.
  function top(...right) {
    return el('div', { class: 'h-top' }, logo(), el('div', { class: 'h-right' }, ...right));
  }

  // --- salle d'attente
  function lobbyView() {
    H.chips = new Map();
    const url = BASE;
    const qr = el('div', { class: 'qr' });
    try {
      const code = qrcode(0, 'M');
      code.addData(url);
      code.make();
      qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      const svg = qr.querySelector('svg');
      if (svg && !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
    } catch (e) { qr.hidden = true; }
    H.refs.count = el('b', { text: '0' });
    H.refs.chips = el('div', { class: 'chips' });
    const slash = SHORT.lastIndexOf('/');
    // Texte d'accueil à côté du QR code, puis l'adresse sur toute la largeur de l'encadré (sur une seule ligne).
    H.refs.joinBox = el('div', { class: 'join-box' },
      el('div', { class: 'lbl l1', text: 'Pour jouer, sur votre téléphone ou ordinateur :' }),
      qr,
      el('div', { class: 'url' }, slash > 0 ? [SHORT.slice(0, slash + 1), el('span', { text: SHORT.slice(slash + 1) })] : SHORT),
      el('div', { class: 'lbl l2', text: 'puis choisissez un pseudo' }));
    H.refs.left = el('div', { class: 'lobby-left' },
      el('h1', { class: 'title', text: H.quiz.title }),
      underline(),
      H.quiz.description && el('p', { text: H.quiz.description }),
      H.quiz.cover && el('img', { class: 'lobby-cover', src: H.quiz.cover, alt: '' }));
    H.refs.right = el('div', { class: 'lobby-right' },
      H.refs.joinBox,
      el('div', { class: 'count-line' }, H.refs.count, el('span', { text: 'participants' })),
      H.refs.chips);
    // Règles du jeu sur toute la largeur, sous les deux colonnes, pour que chacun se prépare.
    const rl = rules(H.quiz.rules);
    const rulesRow = rl.length > 0 && el('div', { class: 'rules' },
      el('div', { class: 'rules-h', text: 'Règles du jeu' }),
      el('div', { class: 'rules-row' }, rl.map(r => el('div', { class: 'rule' }, el('b', { text: r.k }), el('span', { text: r.t })))));
    H.refs.lobby = el('div', { class: 'lobby' }, H.refs.left, H.refs.right, rulesRow);
    return el('div', { class: 'view' },
      top(el('span', { class: 'pill', text: H.quiz.questions.length + ' questions' })),
      H.refs.lobby,
      controls('Cliquez sur un pseudo pour le retirer',
        el('button', {
          class: 'btn ghost', type: 'button', text: 'Copier le lien',
          onclick: e => { navigator.clipboard.writeText(url).then(() => { e.target.textContent = 'Lien copié ✓'; }, () => flash(url)); },
        }),
        primary('Commencer ▶', () => op('start'))));
  }

  // Réduit la police d'un bloc jusqu'à ce que son contenu tienne (100 pseudos et plus).
  function fit(box, maxCqw, minCqw) {
    let s = maxCqw;
    box.style.fontSize = s + 'cqw';
    while (s > minCqw && (box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1)) {
      s = Math.round((s - 0.05) * 100) / 100;
      box.style.fontSize = s + 'cqw';
    }
  }

  function updateLobby() {
    const list = players();
    const changed = list.length !== H.chips.size;
    H.refs.count.textContent = list.length;
    H.refs.count.nextSibling.textContent = list.length > 1 ? 'participants' : 'participant';
    const seen = new Set();
    for (const [pub, name] of list) { // avant la 1re question, le classement suit l'ordre d'arrivée
      seen.add(pub);
      if (H.chips.has(pub)) continue;
      const chip = el('button', {
        class: 'chip', type: 'button', text: name, title: 'Retirer ' + name,
        onclick: () => { if (confirm(`Retirer « ${name} » de la partie ?`)) op('kick', { pub }); },
      });
      H.chips.set(pub, chip);
      H.refs.chips.append(chip);
    }
    for (const [pub, chip] of H.chips) if (!seen.has(pub)) { chip.remove(); H.chips.delete(pub); }
    // Au-delà de 24 inscrits : l'image disparaît et l'encadré « pour jouer » passe à gauche, les pseudos ont toute la colonne de droite.
    const crowd = list.length > 24;
    if (crowd !== H.refs.lobby.classList.contains('crowd')) {
      H.refs.lobby.classList.toggle('crowd', crowd);
      (crowd ? H.refs.left : H.refs.right).insertBefore(H.refs.joinBox, crowd ? null : H.refs.right.firstChild);
    }
    if (changed) fit(H.refs.chips, 1.3, 0.55);
  }

  // --- compte à rebours
  function readyView() {
    const g = game(), q = H.quiz.questions[g.qi];
    H.refs.count = el('div', { class: 'n' });
    return el('div', { class: 'view' },
      top(el('span', { class: 'pill', text: H.quiz.title })),
      el('div', { class: 'ready' },
        el('div', { class: 'k', text: `Question ${g.qi + 1} / ${H.quiz.questions.length}` }),
        el('div', { class: 'qt', text: q.q }),
        H.refs.count));
  }

  // --- question et correction
  const CIRC = 2 * Math.PI * 20;

  // rv (mode « Revoir les questions ») : { qi, stats, answered, full, part } à la place de l'état en cours.
  function qView(reveal, rv) {
    const g = rv || game(), q = H.quiz.questions[g.qi], n = H.quiz.questions.length;
    const stats = g.stats || [];
    const maxCount = Math.max(1, ...stats);
    let right;
    if (!reveal) {
      H.refs.ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 48 48');
      for (const c of [bg, H.refs.ringFg]) { c.setAttribute('cx', '24'); c.setAttribute('cy', '24'); c.setAttribute('r', '20'); svg.append(c); }
      bg.setAttribute('class', 'bg');
      H.refs.ringFg.setAttribute('class', 'fg');
      H.refs.ringFg.style.strokeDasharray = String(CIRC);
      H.refs.ringTxt = el('span');
      H.refs.ring = el('div', { class: 'ring' }, svg, H.refs.ringTxt);
      H.refs.answered = el('b', { text: '0' });
      H.refs.answeredOf = el('span');
      right = el('div', { class: 'clock' }, el('div', { class: 'answered' }, H.refs.answered, H.refs.answeredOf), H.refs.ring);
    } else {
      const allRight = rv ? rv.full : players().filter(p => p[4] === 1).length;
      const partial = rv ? rv.part : players().filter(p => p[4] === 2).length;
      right = el('div', { class: 'answered' }, el('b', { text: `${allRight} / ${players().length}` }),
        'tout juste' + (partial ? ` · ${partial} en partie` : ''));
    }
    const tiles = q.choices.map((c, i) => {
      const cls = 'tile c' + (i % 6) + (reveal ? (c.ok ? ' good' : ' wrong') : '');
      const fill = el('span', { class: 'fill' });
      if (reveal) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (100 * (stats[i] || 0) / maxCount) + '%'; }));
      return el('div', { class: cls },
        fill,
        el('span', { class: 'letter', text: LETTERS[i] }),
        el('span', { class: 'txt', text: c.s || c.t }),
        reveal && el('span', { class: 'cnt', text: String(stats[i] || 0) }),
        reveal && el('span', { class: 'verd', text: c.ok ? '✔' : '✘' }));
    });
    const last = g.qi + 1 >= n;
    // Diapositive d'explication (importée de Kahoot) : affichée à la correction, touche E pour revenir au tracé.
    if (!reveal && q.explain) new Image().src = q.explain; // préchargée pour la correction
    const ex = reveal && q.explain;
    const imgBox = el('div', { class: 'img' + (ex ? ' show-ex' : '') },
      q.img ? el('img', { class: 'q-img', src: q.img, alt: '' }) : null,
      ex ? el('img', { class: 'ex-img', src: q.explain, alt: '' }) : null);
    const exBtn = ex ? (H.refs.exBtn = el('button', {
      class: 'btn ghost', type: 'button', text: 'Voir le tracé', title: 'Basculer tracé / explication (touche E)',
      onclick: e => { const on = imgBox.classList.toggle('show-ex'); e.currentTarget.textContent = on ? 'Voir le tracé' : 'Voir l’explication'; },
    })) : null;
    const ctrls = rv ? controls(rv.hint, exBtn, bigButton(), ...rv.buttons) : reveal
      ? controls(null, exBtn, bigButton(),
        el('button', { class: 'btn ghost', type: 'button', text: last ? 'Podium direct' : 'Question suivante ⏭', onclick: () => op(last ? 'podium' : 'next') }),
        primary('Classement ▶', () => op('scores')))
      : controls(null, bigButton(), primary('Clore la question', () => { H.closeSent[g.qi] = true; op('close'); }));
    return el('div', { class: 'view' },
      top(el('span', { class: 'pill', text: `${rv ? 'Révision · ' : ''}Question ${g.qi + 1} / ${n}` }), right),
      el('div', { class: 'qwrap' },
        imgBox,
        el('div', { class: 'htiles' },
          el('div', { class: 'q', text: q.q }),
          ...tiles,
          reveal && el('div', { class: 'summary', text: `${g.answered} réponse${g.answered > 1 ? 's' : ''} · bonnes réponses : ${q.choices.map((c, i) => (c.ok ? LETTERS[i] : '')).join('')}` }))),
      ctrls);
  }

  function updateQuestion() {
    if (!H.refs.answered) return;
    H.refs.answered.textContent = String(H.st.answered);
    H.refs.answeredOf.textContent = ` / ${players().length} réponses`;
  }

  // --- classement provisoire
  function scoresView() {
    const g = game(), n = H.quiz.questions.length, last = g.qi + 1 >= n;
    const rows = players().slice(0, 5).map((p, i) => el('div', { class: 'brow', style: `animation-delay:${i * 0.12}s` },
      el('span', { class: 'rk', text: String(i + 1) }),
      el('span', { class: 'nm', text: p[1] }),
      p[3] ? el('span', { class: 'gain', text: '+' + fmt(p[3]) }) : null,
      el('span', { class: 'sc', text: fmt(p[2]) })));
    return el('div', { class: 'view' },
      top(el('span', { class: 'pill', text: `Après la question ${g.qi + 1} / ${n}` })),
      el('div', { class: 'board' }, el('h2', { text: 'Classement' }), underline(), rows.length ? rows : el('p', { text: 'Aucun participant.' })),
      controls(null, last
        ? primary('Podium 🏆', () => op('podium'))
        : primary(`Question ${g.qi + 2} ▶`, () => op('next'))));
  }

  // --- podium
  function podiumView() {
    H.refs.steps = {};
    const mk = place => {
      const who = el('div', { class: 'who' });
      const s = el('div', { class: 'step p' + place }, who, el('div', { class: 'block', text: String(place) }));
      H.refs.steps[place] = { s, who };
      return s;
    };
    H.refs.podiumBtn = primary('', () => op(game().podium >= 3 ? 'end' : 'podium_next'));
    return el('div', { class: 'view' },
      top(el('span', { class: 'pill', text: players().length + ' participants' })),
      el('div', { class: 'podium-title' }, el('h2', { text: 'Le podium' }), underline()),
      el('div', { class: 'podium' }, mk(2), mk(1), mk(3)),
      controls(null, H.refs.podiumBtn));
  }

  function updatePodium() {
    const step = game().podium, list = players();
    const labels = ['Révéler la 3e place', 'Révéler la 2e place', 'Révéler le vainqueur', 'Classement complet ▶'];
    H.refs.podiumBtn.textContent = labels[step];
    for (const place of [1, 2, 3]) {
      const { s, who } = H.refs.steps[place];
      const shown = step >= 4 - place && list[place - 1];
      if (shown && !s.classList.contains('shown')) {
        who.replaceChildren(document.createTextNode(list[place - 1][1]), el('small', { text: fmt(list[place - 1][2]) + ' pts' }));
        s.classList.add('shown');
        if (place === 1) confetti(stage, 6000);
      }
    }
  }

  // --- fin
  function endView() {
    const list = players();
    const medals = ['🥇', '🥈', '🥉'];
    return el('div', { class: 'view' },
      top(el('span', { class: 'pill', text: 'Classement final' })),
      el('div', { class: 'final' },
        el('div', { class: 'board', style: 'align-items:stretch' },
          el('h2', { text: 'Merci à tous !' }),
          underline(),
          list.slice(0, 3).map((p, i) => el('div', { class: 'brow', style: `width:100%;animation-delay:${i * 0.12}s` },
            el('span', { text: medals[i] }), el('span', { class: 'nm', text: p[1] }), el('span', { class: 'sc', text: fmt(p[2]) })))),
        H.refs.ranking = el('ol', { style: `columns:${list.length > 40 ? 3 : list.length > 12 ? 2 : 1}` }, list.map((p, i) => el('li', {},
          el('span', { text: ordinal(i + 1) }), el('span', { text: p[1] }), el('span', { text: fmt(p[2]) }))))),
      controls(null,
        el('button', { class: 'btn ghost', type: 'button', text: 'Revoir les questions', onclick: startReview }),
        el('a', { class: 'btn ghost', href: 'api.php?a=export&pin=' + H.pin, text: 'Exporter (CSV)', style: 'text-decoration:none' }),
        el('button', { class: 'btn', type: 'button', text: 'Nouvelle partie', onclick: () => { store.del(PIN_KEY); setupScreen(); } })));
  }

  // --- revoir les questions (après le classement final, pour expliquer les réponses ; rien ne change sur les téléphones)
  async function startReview() {
    let data;
    try { data = (await api('review', null, { pin: H.pin })).review; } catch (e) { return flash(e.message); }
    const list = data.map((d, i) => (d ? i : -1)).filter(i => i >= 0);
    if (!list.length) return flash('Aucune question corrigée.');
    H.review = { list, data, k: 0 };
    render();
  }

  function reviewGo(k) {
    if (k < 0) return;
    if (k >= H.review.list.length) { H.review = null; return render(); }
    H.review.k = k;
    render();
  }

  function reviewView() {
    const { list, data, k } = H.review, qi = list[k], d = data[qi];
    const last = k + 1 >= list.length;
    H.refs.prev = el('button', { class: 'btn ghost', type: 'button', text: '◀ Précédente', disabled: k === 0, onclick: () => reviewGo(k - 1) });
    const buttons = [
      el('button', { class: 'btn ghost', type: 'button', text: 'Classement final', onclick: () => reviewGo(list.length) }),
      H.refs.prev,
      primary(last ? 'Classement final ▶' : 'Suivante ▶', () => reviewGo(k + 1))];
    return qView(true, Object.assign({ qi, hint: `${k + 1} / ${list.length} · flèches ◀ ▶`, buttons }, d));
  }

  // ------------------------------------------------------------ démarrage
  (async function boot() {
    try {
      const j = await api('whoami');
      if (j.host) setupScreen(); else loginScreen();
    } catch (e) {
      panel(el('h1', { text: 'Serveur injoignable' }), el('p', { text: e.message }));
    }
  })();
})();
