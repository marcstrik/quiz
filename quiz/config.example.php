<?php
// Live Quiz – configuration. Copy this file to config.php (never commit config.php).
//
// 1. Presenter password: generate its hash with
//      php -r "echo password_hash('your-password', PASSWORD_DEFAULT), PHP_EOL;"
//    and paste it below.
// 2. SECRET: any long random string, used to sign the presenter's login cookie. Generate one with
//      php -r "echo bin2hex(random_bytes(32)), PHP_EOL;"
const ADMIN_PASSWORD_HASH = 'paste-the-hash-here';
const SECRET = 'paste-a-long-random-string-here';
