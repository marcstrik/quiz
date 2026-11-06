<?php
// Liryc Quiz – API JSON. Joueurs : join, hello, answer. Animateur : login, quizzes, host, host_state, export.
declare(strict_types=1);

require __DIR__ . '/lib.php';

$in = $_GET;
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $body = json_decode((string) file_get_contents('php://input'), true);
    if (is_array($body)) {
        $in = array_merge($in, $body);
    }
}

switch ((string) ($in['a'] ?? '')) {
    case 'time':
        out(['ok' => true]);
        break;
    case 'join':
        api_join($in);
        break;
    case 'hello':
        require_post();
        [, $g, $p] = auth_player($in);
        out(['ok' => true, 'name' => $p['name'], 'phase' => $g['phase']]);
        break;
    case 'answer':
        api_answer($in);
        break;
    case 'login':
        api_login($in);
        break;
    case 'logout':
        setcookie('lqh', '', ['expires' => 1, 'path' => cookie_path()]);
        out(['ok' => true]);
        break;
    case 'whoami':
        out(['ok' => true, 'host' => is_host()]);
        break;
    case 'quizzes':
        require_host();
        out(['ok' => true, 'quizzes' => list_quizzes()]);
        break;
    case 'host':
        require_host();
        api_host($in);
        break;
    case 'host_state':
        require_host();
        api_host_state($in);
        break;
    case 'export':
        require_host();
        api_export($in);
        break;
    case 'review':
        require_host();
        api_review($in);
        break;
    default:
        fail('Action inconnue', 404);
}

function api_join(array $in): void
{
    require_post();
    $pin = current_pin();
    $g = load_game($pin);
    if (!$g) {
        fail("Aucun quiz n'est ouvert pour l'instant. Réessayez dans un instant.");
    }
    if ($g['phase'] === 'end') {
        fail('Le quiz est terminé. Merci !');
    }
    $name = clean_name((string) ($in['name'] ?? ''));
    if ($name === '') {
        fail('Choisissez un pseudo (1 à ' . NAME_MAX . ' caractères)');
    }
    $dir = game_dir($pin);
    if (count(glob($dir . '/players/*.json') ?: []) >= MAX_PLAYERS) {
        fail('La partie est complète');
    }
    $h = @fopen($dir . '/names/' . sha1(str_lower($name)), 'x');
    if ($h === false) {
        fail('Ce pseudo est déjà pris, choisissez-en un autre');
    }
    fclose($h);
    $pub = bin2hex(random_bytes(5));
    $tok = bin2hex(random_bytes(16));
    write_json_atomic("$dir/players/$pub.json", ['pub' => $pub, 'tok' => $tok, 'name' => $name, 'joined' => now_ms()]);
    out(['ok' => true, 'pin' => $pin, 'pub' => $pub, 'tok' => $tok, 'name' => $name]);
}

function api_answer(array $in): void
{
    require_post();
    [$pin, $g, $p] = auth_player($in);
    $now = now_ms();
    $qi = (int) ($in['qi'] ?? -1);
    if ($g['phase'] !== 'question' || $qi !== (int) $g['qi']) {
        fail('Trop tard : la question est close');
    }
    if ($now < $g['started'] - 300) {
        fail("La question n'a pas encore commencé");
    }
    if ($now > $g['ends'] + GRACE_MS) {
        fail('Trop tard : le temps est écoulé');
    }
    $quiz = load_quiz($g['quiz']);
    $n = count($quiz['questions'][$qi]['choices']);
    $sel = [];
    foreach ((array) ($in['c'] ?? []) as $i) {
        if (!is_int($i) || $i < 0 || $i >= $n) {
            fail('Réponse invalide');
        }
        $sel[$i] = true;
    }
    if (!$sel) {
        fail('Cochez au moins une réponse');
    }
    $sel = array_keys($sel);
    sort($sel);
    $ms = max(0, min($now - (int) $g['started'], (int) $g['ends'] - (int) $g['started']));

    // Écriture puis link() : création atomique et exclusive (une seule réponse par joueur).
    $final = game_dir($pin) . '/a' . $qi . '/' . $p['pub'] . '.json';
    $tmp = $final . '.' . bin2hex(random_bytes(4)) . '.tmp';
    file_put_contents($tmp, json_encode(['c' => $sel, 'ms' => $ms]));
    $ok = @link($tmp, $final);
    @unlink($tmp);
    if (!$ok) {
        fail(file_exists($final) ? 'Vous avez déjà répondu' : 'Enregistrement impossible, réessayez', file_exists($final) ? 409 : 500);
    }
    out(['ok' => true, 'ms' => $ms, 'c' => $sel]);
}

function api_login(array $in): void
{
    require_post();
    usleep(400000); // freine les essais de mot de passe
    if (!password_verify((string) ($in['password'] ?? ''), ADMIN_PASSWORD_HASH)) {
        fail('Mot de passe incorrect', 403);
    }
    $exp = time() + 12 * 3600;
    setcookie('lqh', $exp . '.' . sign('host|' . $exp), [
        'expires' => $exp,
        'path' => cookie_path(),
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    out(['ok' => true]);
}

function api_host(array $in): void
{
    require_post();
    $op = (string) ($in['op'] ?? '');

    if ($op === 'create') {
        $quizId = (string) ($in['quiz'] ?? '');
        $quiz = load_quiz($quizId);
        ensure_dir(DATA_DIR);
        $pin = new_pin();
        $dir = game_dir($pin);
        foreach (['', '/players', '/names'] as $sub) {
            ensure_dir($dir . $sub);
        }
        save_game([
            'pin' => $pin,
            'quiz' => $quizId,
            'phase' => 'lobby',
            'qi' => -1,
            'started' => 0,
            'ends' => 0,
            'podium' => 0,
            'kicked' => [],
            'scored' => (object) [],
            'stats' => null,
            'answered' => 0,
            'created' => now_ms(),
            'seq' => 0,
        ], $quiz);
        api_host_state(['pin' => $pin, 'full' => 1]);
    }

    $pin = (string) ($in['pin'] ?? '');
    if (!load_game($pin)) {
        fail('Partie introuvable', 404);
    }
    with_game_lock($pin, function () use ($pin, $op, $in) {
        $g = load_game($pin);
        $g['scored'] = (array) ($g['scored'] ?? []);
        $quiz = load_quiz($g['quiz']);
        $n = count($quiz['questions']);
        $phase = $g['phase'];
        switch ($op) {
            case 'start':
                if ($phase !== 'lobby') {
                    return;
                }
                open_question($g, $quiz, 0);
                break;
            case 'close':
                if ($phase !== 'question' || !empty($g['scored'][(string) $g['qi']])) {
                    return;
                }
                score_question($g, $quiz);
                break;
            case 'scores':
                if ($phase !== 'reveal') {
                    return;
                }
                $g['phase'] = 'scores';
                break;
            case 'next':
                if (!in_array($phase, ['reveal', 'scores'], true) || $g['qi'] + 1 >= $n) {
                    return;
                }
                open_question($g, $quiz, $g['qi'] + 1);
                break;
            case 'podium':
                if (!in_array($phase, ['reveal', 'scores'], true)) {
                    return;
                }
                $g['phase'] = 'podium';
                $g['podium'] = 0;
                break;
            case 'podium_next':
                if ($phase !== 'podium' || $g['podium'] >= 3) {
                    return;
                }
                $g['podium']++;
                break;
            case 'end':
                if ($phase !== 'podium') {
                    return;
                }
                $g['phase'] = 'end';
                break;
            case 'abort':
                // Fin anticipée, depuis n'importe quelle étape : tout le monde passe au classement final.
                // Une question en cours n'est pas corrigée (ses réponses ne comptent pas).
                if ($phase === 'end') {
                    return;
                }
                $g['phase'] = 'end';
                $g['podium'] = 3;
                break;
            case 'activate':
                // Reprise d'une ancienne partie : elle redevient la partie ouverte (save_game ci-dessous).
                break;
            case 'kick':
                $pub = (string) ($in['pub'] ?? '');
                if (!preg_match('/^[a-f0-9]{10}$/', $pub) || in_array($pub, $g['kicked'], true)) {
                    return;
                }
                $g['kicked'][] = $pub;
                break;
            default:
                fail('Action inconnue');
        }
        save_game($g, $quiz);
    });
    api_host_state(['pin' => $pin, 'full' => $in['full'] ?? 0]);
}

function api_host_state(array $in): void
{
    $pin = (string) ($in['pin'] ?? '');
    $g = load_game($pin);
    if (!$g) {
        fail('Partie introuvable', 404);
    }
    sync_live($g);
    $answered = (int) ($g['answered'] ?? 0);
    if ($g['phase'] === 'question') {
        $answered = 0;
        foreach (answer_files($pin, (int) $g['qi']) as $f) {
            if (!in_array(basename($f, '.json'), $g['kicked'], true)) {
                $answered++;
            }
        }
    }
    $res = [
        'ok' => true,
        'game' => $g,
        'answered' => $answered,
        'players' => array_map(function ($r) {
            return [$r['pub'], $r['name'], $r['s'], $r['lp'], $r['lo'], $r['nc']];
        }, ranking($pin, $g)),
    ];
    if (!empty($in['full'])) {
        $res['quiz'] = load_quiz($g['quiz']);
        $res['quiz']['rules'] = quiz_rules($res['quiz']);
    }
    out($res);
}

// Récapitulatif de chaque question corrigée (lecture seule, pour réexpliquer le quiz à la fin).
function api_review(array $in): void
{
    $pin = (string) ($in['pin'] ?? '');
    $g = load_game($pin);
    if (!$g) {
        fail('Partie introuvable', 404);
    }
    $quiz = load_quiz($g['quiz']);
    $mode = (string) ($quiz['scoring'] ?? 'partial');
    $scored = (array) ($g['scored'] ?? []);
    $out = [];
    foreach ($quiz['questions'] as $qi => $q) {
        if (empty($scored[(string) $qi])) {
            $out[] = null;
            continue;
        }
        $correct = correct_indices($q);
        $stats = array_fill(0, count($q['choices']), 0);
        $answered = $full = $part = 0;
        foreach (answer_files($pin, $qi) as $f) {
            $a = read_json($f);
            if (!is_array($a) || in_array(basename($f, '.json'), $g['kicked'], true)) {
                continue;
            }
            $answered++;
            foreach ($a['c'] as $i) {
                if (isset($stats[$i])) {
                    $stats[$i]++;
                }
            }
            $frac = answer_fraction($a['c'], $correct, $mode);
            if ($frac >= 1) {
                $full++;
            } elseif ($frac > 0) {
                $part++;
            }
        }
        $out[] = ['stats' => $stats, 'answered' => $answered, 'full' => $full, 'part' => $part];
    }
    out(['ok' => true, 'review' => $out]);
}

function api_export(array $in): void
{
    $pin = (string) ($in['pin'] ?? '');
    $g = load_game($pin);
    if (!$g) {
        fail('Partie introuvable', 404);
    }
    $quiz = load_quiz($g['quiz']);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="classement-' . $g['quiz'] . '-' . $pin . '.csv"');
    $fh = fopen('php://output', 'w');
    fwrite($fh, "\xEF\xBB\xBF");
    fputcsv($fh, ['Rang', 'Pseudo', 'Points', 'Bonnes réponses', 'Questions'], ';');
    foreach (ranking($pin, $g) as $r) {
        fputcsv($fh, [$r['rank'], $r['name'], $r['s'], $r['nc'], count($quiz['questions'])], ';');
    }
    fclose($fh);
    exit;
}
