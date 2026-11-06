/* Liryc Quiz – utilitaires communs (joueur + animateur) */
'use strict';

const LQ = (() => {
  const LETTERS = 'ABCDEFGH';

  async function api(action, body, query) {
    const qs = new URLSearchParams(Object.assign({ a: action }, query || {}));
    const opts = { cache: 'no-store', credentials: 'same-origin' };
    if (body) {
      opts.method = 'POST';
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    let r, j;
    try {
      r = await fetch('api.php?' + qs, opts);
      j = await r.json();
    } catch (e) {
      const err = new Error('Connexion au serveur impossible. Réessayez.');
      err.network = true;
      throw err;
    }
    if (!j.ok) {
      const err = new Error(j.error || 'Erreur');
      err.status = r.status;
      throw err;
    }
    return j;
  }

  // Décalage horloge serveur − horloge locale (meilleur de 3 allers-retours).
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const j = await api('time');
      const t1 = Date.now();
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: j.now - (t0 + t1) / 2 };
    }
    return best.off;
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  const fmt = n => Number(n || 0).toLocaleString('fr-FR');
  const ordinal = n => (n === 1 ? '1er' : n + 'e');
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } },
  };

  // Règles du jeu affichées en salle d'attente, d'après les réglages du quiz (quiz_rules() côté serveur) :
  // r = { t: [min, max] secondes par question, sc: 'partial' | 'exact', pm: multiplicateur de points max,
  //       one: quiz à réponse unique (importé de Kahoot) }.
  // Chaque règle : k = chiffre clé, t = la suite de la phrase, c = liaison k → t sur une même ligne (téléphone),
  // ex = exemple (téléphone seulement).
  function rules(r) {
    if (!r || !r.t) return [];
    const sp = ' ';
    const [t1, t2] = r.t;
    const pts = [
      'au maximum, si vous répondez tout de suite' + sp + '; 500 à la dernière seconde.',
      r.pm > 1 ? 'Certaines questions comptent ×' + String(r.pm).replace('.', ',') + '.' : '',
    ].filter(Boolean).join(' ');
    return [
      { k: (t1 === t2 ? t1 : t1 + '–' + t2) + sp + 's', t: 'par question. Le chrono démarre quand les réponses s’affichent.' },
      r.one
        ? { k: '1 seule', t: 'bonne réponse' + sp + ': touchez-la sur votre téléphone. Réponse définitive.' }
        : { k: '1 ou plusieurs', t: 'bonnes réponses' + sp + ': cochez-les toutes, puis «' + sp + 'Valider' + sp + '». Réponse définitive.' },
      { k: '1' + sp + '000' + sp + 'pts', t: pts }, // espace insécable classique : Montserrat n'a pas l'espace fine de fmt()
      r.one
        ? { k: 'Bonne réponse', c: sp + ': ', t: 'les points. Mauvaise réponse ou pas de réponse' + sp + ': 0.' }
        : r.sc === 'exact'
        ? { k: 'Tout ou rien', c: sp + ': ', t: 'il faut cocher toutes les bonnes réponses, et aucune mauvaise.' }
        : {
          k: 'Points partiels', c: sp + ': ', t: 'chaque bonne case cochée rapporte sa part, chaque mauvaise en retire une (minimum 0).',
          ex: 'Ex.' + sp + ': 3 bonnes réponses, 2 cochées → 2/3 des points.',
        },
    ];
  }

  // Confettis légers, sans dépendance.
  function confetti(host, ms) {
    const c = el('canvas', { class: 'confetti' });
    host.append(c);
    const ctx = c.getContext('2d');
    const W = (c.width = c.offsetWidth * devicePixelRatio);
    const H = (c.height = c.offsetHeight * devicePixelRatio);
    const colors = ['#e7b416', '#42b9d3', '#0d6b84', '#012243', '#e05a66', '#2aa57a'];
    const parts = Array.from({ length: 220 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35,
      vx: (Math.random() - 0.5) * W * 0.018, vy: -Math.random() * H * 0.025 - H * 0.006,
      s: (6 + Math.random() * 8) * devicePixelRatio, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += H * 0.0006; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      }
      if (t - t0 < (ms || 5000)) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  return { api, syncClock, el, fmt, ordinal, store, confetti, rules, LETTERS };
})();
