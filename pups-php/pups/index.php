<?php
// Personal Upload Server (RFC-6). Every request comes here, see .htaccess and README.md.
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit('PUPS needs PHP 8.1 or later, and this server runs PHP ' . PHP_VERSION . ". Choose a newer PHP version in your hosting control panel.\n");
}
require __DIR__ . '/controller.php';
Pups\run(__DIR__);
