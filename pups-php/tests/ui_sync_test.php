<?php
// The owner-page files copied from pups-ui (scripts/sync-ui.sh) must be up to date.

namespace Pups\Test;

test('pups-ui: the copies of owner.css, owner.js and texts.json match pups-ui, if it is checked out', function () {
    $ui = dirname(__DIR__, 2) . '/pups-ui';
    if (!is_file("$ui/texts.json"))
        return;
    $root = dirname(__DIR__) . '/pups';
    foreach (['public/pups/assets/owner.css' => 'assets/owner.css', 'public/pups/assets/owner.js' => 'assets/owner.js', 'texts.json' => 'lib/texts.json'] as $from => $to)
        ok(file_get_contents("$ui/$from") === file_get_contents("$root/$to"), "$to is out of date: run scripts/sync-ui.sh");
});
