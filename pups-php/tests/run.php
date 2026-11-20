<?php
// Runs the tests: php tests/run.php [filter]

namespace Pups\Test;

error_reporting(E_ALL);
set_error_handler(function (int $no, string $msg, string $file, int $line) {
    if (error_reporting() & $no)
        throw new \ErrorException($msg, 0, $no, $file, $line);
    return false;
});

require __DIR__ . '/lib.php';
foreach (glob(__DIR__ . '/*_test.php') as $file)
    require $file;

exit(runAll($argv[1] ?? null));
