<?php
// Liryc Quiz – fonctions communes (PHP >= 7.4).
//
// Stockage en fichiers, adapté au disque NFS de l'hébergement (pas de SQLite) :
//   data/g<PIN>/game.json        état de la partie        (écrit par l'animateur seul)
//   data/g<PIN>/scores.json      scores cumulés           (écrit par l'animateur seul)
//   data/g<PIN>/players/<id>.json un fichier par joueur   (créé une fois)
//   data/g<PIN>/names/<sha1>     réserve le pseudo        (création exclusive)
//   data/g<PIN>/a<n>/<id>.json   une réponse par joueur   (création exclusive via link())
//   live/<PIN>.json              état public, servi en statique aux téléphones
//   live/current.json            partie ouverte : les joueurs la rejoignent sans saisir de code
// Le « PIN » n'est qu'un identifiant interne de partie ; les joueurs ne le voient jamais.
declare(strict_types=1);

if (!is_file(__DIR__ . '/config.php')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    exit(json_encode(['ok' => false, 'error' => 'config.php manquant : copiez config.example.php en config.php (voir README)']));
}
require __DIR__ . '/config.php';

const DATA_DIR = __DIR__ . '/data';
const LIVE_DIR = __DIR__ . '/live';
const CURRENT_FILE = LIVE_DIR . '/current.json';
const QUIZ_DIR = __DIR__ . '/quizzes';
const LEAD_MS = 4000;      // compte à rebours « Préparez-vous » avant chaque question
const GRACE_MS = 1500;     // tolérance réseau après la fin du temps
const MAX_PLAYERS = 400;
const NAME_MAX = 20;

function now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

function out(array $data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    $data['now'] = now_ms();
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    out(['ok' => false, 'error' => $msg], $code);
}

function require_post(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        fail('Méthode non autorisée', 405);
    }
}

function read_json(string $file)
{
    $s = @file_get_contents($file);
    if ($s === false || $s === '') {
        return null;
    }
    return json_decode($s, true);
}

// Écrit dans un fichier temporaire puis renomme : les lecteurs voient l'ancien ou le nouveau, jamais un fichier tronqué.
// Sous Windows, renommer sur un fichier en cours de lecture échoue : on réessaie brièvement.
function write_json_atomic(string $file, $data, bool $fatal = true): bool
{
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $done = file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false;
    for ($try = 0; $done && $try < 25; $try++) {
        if (@rename($tmp, $file)) {
            return true;
        }
        usleep(20000);
    }
    @unlink($tmp);
    if ($fatal) {
        fail('Écriture impossible sur le serveur', 500);
    }
    return false;
}

function ensure_dir(string $dir): void
{
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        fail('Dossier inaccessible sur le serveur', 500);
    }
}

function str_len(string $s): int
{
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen(utf8_decode($s));
}

function str_lower(string $s): string
{
    return function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
}

function clean_name(string $s): string
{
    $s = (string) preg_replace('/[\x00-\x1F\x7F<>]/u', '', $s);
    $s = trim((string) preg_replace('/\s+/u', ' ', $s));
    if (str_len($s) > NAME_MAX) {
        $s = function_exists('mb_substr') ? mb_substr($s, 0, NAME_MAX, 'UTF-8') : substr($s, 0, NAME_MAX);
    }
    return trim($s);
}

// ---------------------------------------------------------------- quiz

function valid_id(string $id): bool
{
    return preg_match('/^[a-z0-9_-]{1,40}$/', $id) === 1;
}

function load_quiz(string $id): array
{
    $q = valid_id($id) ? read_json(QUIZ_DIR . "/$id.json") : null;
    if (!is_array($q) || empty($q['questions'])) {
        fail('Quiz introuvable', 404);
    }
    return $q;
}

function list_quizzes(): array
{
    $list = [];
    foreach (glob(QUIZ_DIR . '/*.json') ?: [] as $f) {
        $q = read_json($f);
        if (is_array($q) && !empty($q['questions'])) {
            $list[] = ['id' => basename($f, '.json'), 'title' => $q['title'] ?? basename($f), 'n' => count($q['questions'])];
        }
    }
    return $list;
}

function question_time_ms(array $quiz, int $qi): int
{
    $q = $quiz['questions'][$qi];
    return (int) (($q['time'] ?? $quiz['time'] ?? 30) * 1000);
}

function correct_indices(array $question): array
{
    $ok = [];
    foreach ($question['choices'] as $i => $c) {
        if (!empty($c['ok'])) {
            $ok[] = $i;
        }
    }
    return $ok;
}

// Part des points obtenue (0..1).
//  partial (défaut) : (bonnes cochées − mauvaises cochées) / nombre de bonnes, plancher 0
//                     ex. 3 bonnes : 2 bonnes cochées = 2/3 ; 2 bonnes + 1 mauvaise = 1/3
//  exact            : tout ou rien (toutes les bonnes cases, aucune mauvaise)
function answer_fraction(array $sel, array $correct, string $mode): float
{
    $good = count(array_intersect($sel, $correct));
    $bad = count(array_diff($sel, $correct));
    if ($mode === 'partial') {
        return $correct ? max(0.0, ($good - $bad) / count($correct)) : 0.0;
    }
    return ($bad === 0 && $good === count($correct)) ? 1.0 : 0.0;
}

// Barème « vitesse » : 1000 pts si réponse immédiate, 500 pts à la dernière seconde.
function speed_points(int $ms, int $timeMs, float $fraction, float $mult): int
{
    if ($fraction <= 0) {
        return 0;
    }
    $r = $timeMs > 0 ? min(1.0, max(0.0, $ms / $timeMs)) : 0.0;
    return (int) round(1000 * $mult * $fraction * (1 - $r / 2));
}

// Réglages utiles pour annoncer les règles (salle d'attente) : durée par question (min, max en s),
// barème, multiplicateur de points le plus élevé.
function quiz_rules(array $quiz): array
{
    $t = [];
    $pm = 1.0;
    foreach ($quiz['questions'] as $i => $q) {
        $t[] = (int) round(question_time_ms($quiz, $i) / 1000);
        $pm = max($pm, (float) ($q['points'] ?? 1));
    }
    return ['t' => [min($t), max($t)], 'sc' => (string) ($quiz['scoring'] ?? 'partial'), 'pm' => $pm, 'one' => !empty($quiz['single'])];
}

// ---------------------------------------------------------------- partie

function valid_pin(string $pin): bool
{
    return preg_match('/^\d{6}$/', $pin) === 1;
}

function game_dir(string $pin): string
{
    return DATA_DIR . '/g' . $pin;
}

function load_game(string $pin): ?array
{
    if (!valid_pin($pin)) {
        return null;
    }
    $g = read_json(game_dir($pin) . '/game.json');
    return is_array($g) ? $g : null;
}

function new_pin(): string
{
    for ($i = 0; $i < 50; $i++) {
        $pin = (string) random_int(100000, 999999);
        if (!is_dir(game_dir($pin))) {
            return $pin;
        }
    }
    fail('Impossible de créer une partie', 500);
    return '';
}

function load_players(string $pin): array
{
    $players = [];
    foreach (glob(game_dir($pin) . '/players/*.json') ?: [] as $f) {
        $p = read_json($f);
        if (is_array($p) && isset($p['pub'])) {
            $players[$p['pub']] = $p;
        }
    }
    return $players;
}

function answer_files(string $pin, int $qi): array
{
    return glob(game_dir($pin) . '/a' . $qi . '/*.json') ?: [];
}

// Classement : score décroissant, puis temps cumulé des bonnes réponses, puis ordre d'arrivée.
function ranking(string $pin, array $g): array
{
    $scores = read_json(game_dir($pin) . '/scores.json') ?: [];
    $rows = [];
    foreach (load_players($pin) as $pub => $p) {
        if (in_array($pub, $g['kicked'], true)) {
            continue;
        }
        $s = $scores[$pub] ?? [];
        $rows[] = [
            'pub' => $pub,
            'name' => $p['name'],
            's' => (int) ($s['s'] ?? 0),
            't' => (int) ($s['t'] ?? 0),
            'nc' => (int) ($s['nc'] ?? 0),
            'lp' => (int) ($s['lp'] ?? 0),
            'lo' => (int) ($s['lo'] ?? -1),
            'j' => (int) $p['joined'],
        ];
    }
    usort($rows, function ($a, $b) {
        return [$b['s'], $a['t'], $a['j']] <=> [$a['s'], $b['t'], $b['j']];
    });
    foreach ($rows as $i => $r) {
        $rows[$i]['rank'] = $i + 1;
    }
    return $rows;
}

function open_question(array &$g, array $quiz, int $qi): void
{
    ensure_dir(game_dir($g['pin']) . '/a' . $qi);
    $g['phase'] = 'question';
    $g['qi'] = $qi;
    $g['started'] = now_ms() + LEAD_MS;
    $g['ends'] = $g['started'] + question_time_ms($quiz, $qi);
    $g['stats'] = null;
    $g['answered'] = 0;
}

// Corrige la question en cours : met à jour scores.json et les statistiques.
function score_question(array &$g, array $quiz): void
{
    $pin = $g['pin'];
    $qi = (int) $g['qi'];
    $q = $quiz['questions'][$qi];
    $n = count($q['choices']);
    $correct = correct_indices($q);
    $mode = (string) ($quiz['scoring'] ?? 'partial');
    $mult = (float) ($q['points'] ?? 1);
    $timeMs = question_time_ms($quiz, $qi);

    $file = game_dir($pin) . '/scores.json';
    $scores = read_json($file) ?: [];
    foreach ($scores as $pub => $s) {
        $scores[$pub]['lp'] = 0;
        $scores[$pub]['lo'] = -1;
    }
    $stats = array_fill(0, $n, 0);
    $answered = 0;
    foreach (answer_files($pin, $qi) as $f) {
        $pub = basename($f, '.json');
        $a = read_json($f);
        if (!is_array($a) || in_array($pub, $g['kicked'], true)) {
            continue;
        }
        $answered++;
        foreach ($a['c'] as $i) {
            if (isset($stats[$i])) {
                $stats[$i]++;
            }
        }
        $frac = answer_fraction($a['c'], $correct, $mode);
        $pts = speed_points((int) $a['ms'], $timeMs, $frac, $mult);
        $s = $scores[$pub] ?? ['s' => 0, 't' => 0, 'nc' => 0];
        $s['s'] += $pts;
        $s['t'] += $frac > 0 ? (int) $a['ms'] : 0;
        $s['nc'] = ($s['nc'] ?? 0) + ($frac >= 1 ? 1 : 0);
        $s['lp'] = $pts;
        $s['lo'] = $frac >= 1 ? 1 : ($frac > 0 ? 2 : 0);   // 1 juste, 2 partiel, 0 faux, -1 sans réponse
        $scores[$pub] = $s;
    }
    write_json_atomic($file, $scores);
    $g['stats'] = $stats;
    $g['answered'] = $answered;
    $g['phase'] = 'reveal';
    $g['scored'][(string) $qi] = true;
}

// État public lu par les téléphones (aucune bonne réponse avant la correction).
function live_payload(array $g, array $quiz): array
{
    $phase = $g['phase'];
    $L = [
        'v' => $g['seq'],
        'pin' => $g['pin'],
        'title' => $quiz['title'] ?? '',
        'phase' => $phase,
        'qi' => $g['qi'],
        'n' => count($quiz['questions']),
        'kicked' => $g['kicked'],
        'single' => !empty($quiz['single']), // une seule bonne réponse : un toucher suffit
    ];
    if ($phase === 'lobby') {
        $L['rules'] = quiz_rules($quiz);
    }
    if ($phase === 'question' || $phase === 'reveal') {
        $q = $quiz['questions'][$g['qi']];
        $L['q'] = [
            'q' => $q['q'],
            'img' => $q['img'] ?? null,
            'c' => array_map(function ($c) { return $c['t']; }, $q['choices']),
        ];
        $L['started'] = $g['started'];
        $L['ends'] = $g['ends'];
    }
    if ($phase === 'reveal') {
        $L['correct'] = correct_indices($quiz['questions'][$g['qi']]);
        $L['stats'] = $g['stats'];
    }
    if (in_array($phase, ['reveal', 'scores', 'podium', 'end'], true)) {
        $rows = ranking($g['pin'], $g);
        $res = [];
        foreach ($rows as $r) {
            $res[$r['pub']] = [$r['s'], $r['rank'], $r['lp'], $r['lo']];
        }
        $L['res'] = (object) $res;
        $L['np'] = count($rows);
        if ($phase === 'scores') {
            $L['top'] = array_map(function ($r) { return [$r['name'], $r['s'], $r['lp']]; }, array_slice($rows, 0, 5));
        }
        if ($phase === 'podium' || $phase === 'end') {
            $step = $phase === 'end' ? 3 : (int) $g['podium'];
            $pod = [null, null, null];
            for ($place = 3; $place >= 1; $place--) {
                if ($step >= 4 - $place && isset($rows[$place - 1])) {
                    $pod[$place - 1] = [$rows[$place - 1]['name'], $rows[$place - 1]['s'], $rows[$place - 1]['pub']];
                }
            }
            $L['podium'] = $pod;
            $L['step'] = $step;
        }
    }
    return $L;
}

function save_game(array $g, array $quiz): array
{
    $g['seq'] = ($g['seq'] ?? 0) + 1;
    write_json_atomic(game_dir($g['pin']) . '/game.json', $g);
    ensure_dir(LIVE_DIR);
    // Non bloquant : si l'écriture échoue, sync_live() la refait au prochain rafraîchissement de l'animateur.
    write_json_atomic(LIVE_DIR . '/' . $g['pin'] . '.json', live_payload($g, $quiz), false);
    // Toute action de l'animateur fait de cette partie la partie ouverte.
    write_json_atomic(CURRENT_FILE, current_payload($g, $quiz), false);
    return $g;
}

function current_payload(array $g, array $quiz): array
{
    return ['pin' => $g['pin'], 'v' => $g['seq'], 'phase' => $g['phase'], 'title' => $quiz['title'] ?? ''];
}

function current_pin(): string
{
    $cur = read_json(CURRENT_FILE);
    return is_array($cur) ? (string) ($cur['pin'] ?? '') : '';
}

// Republie l'état public s'il est en retard sur la partie (appelé à chaque rafraîchissement de l'animateur).
function sync_live(array $g): void
{
    $file = LIVE_DIR . '/' . $g['pin'] . '.json';
    $live = read_json($file);
    $cur = read_json(CURRENT_FILE);
    $curStale = !is_array($cur) || (($cur['pin'] ?? '') === $g['pin'] && ($cur['v'] ?? -1) !== $g['seq']);
    if (!is_array($live) || ($live['v'] ?? -1) !== $g['seq'] || $curStale) {
        $quiz = load_quiz($g['quiz']);
        write_json_atomic($file, live_payload($g, $quiz), false);
        if ($curStale) {
            write_json_atomic(CURRENT_FILE, current_payload($g, $quiz), false);
        }
    }
}

// Verrou pour les actions de l'animateur (double clic, deux onglets ouverts).
function with_game_lock(string $pin, callable $fn): void
{
    $h = fopen(game_dir($pin) . '/lock', 'c');
    if ($h === false) {
        fail('Verrou impossible', 500);
    }
    flock($h, LOCK_EX);
    try {
        $fn();
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
}

// ---------------------------------------------------------------- authentification

function sign(string $data): string
{
    return hash_hmac('sha256', $data, SECRET);
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

function cookie_path(): string
{
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return $dir . '/';
}

function is_host(): bool
{
    $parts = explode('.', (string) ($_COOKIE['lqh'] ?? ''), 2);
    if (count($parts) !== 2 || !ctype_digit($parts[0]) || (int) $parts[0] < time()) {
        return false;
    }
    return hash_equals(sign('host|' . $parts[0]), $parts[1]);
}

function require_host(): void
{
    if (!is_host()) {
        fail('Connexion animateur requise', 401);
    }
}

function auth_player(array $in): array
{
    $pin = (string) ($in['pin'] ?? '');
    $g = load_game($pin);
    if (!$g) {
        fail('Partie introuvable', 404);
    }
    $pub = (string) ($in['pub'] ?? '');
    $p = preg_match('/^[a-f0-9]{10}$/', $pub) ? read_json(game_dir($pin) . "/players/$pub.json") : null;
    if (!is_array($p) || !hash_equals((string) $p['tok'], (string) ($in['tok'] ?? ''))) {
        fail('Joueur inconnu', 403);
    }
    if (in_array($pub, $g['kicked'], true)) {
        fail("Vous avez été retiré de la partie par l'animateur", 403);
    }
    return [$pin, $g, $p];
}
