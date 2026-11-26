// Comments on posts: the comment feeds of RFC-1 `_source.comments`, which a PUPS server publishes for the comments
// that the owner approved (RFC-7 "Publishing comments"), one feed of direct replies per post or comment. A post shows
// how many comments it has; they open below it, and on the post's own page right away. The replies to a comment open
// on demand, from their own feed. postviewer parses and renders them (RSS, Atom and JSON Feed comment feeds).
import { createCommentList, parseCommentsFeed } from '@lib/postviewer/src/comments';
import { addHtml, newHtml } from '@lib/postviewer/src/dom';
import { icon } from '@lib/socialspec/src/icons';

/** "1 comment", "3 comments"; just "Comments" when the feed gives no count. */
export const commentsLabel = (count?: number) => count == undefined ? 'Comments' : count == 1 ? '1 comment' : `${count} comments`;

/** The comments of a comment feed, oldest first. Throws if it can't be loaded or isn't a feed. */
async function loadComments(feedUrl: string) {
    const res = await fetch(feedUrl, {headers: {Accept: 'application/feed+json, application/json, application/rss+xml, application/atom+xml, */*'},
        credentials: 'omit', cache: 'no-cache'});
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return parseCommentsFeed(await res.text(), feedUrl);
}

/** Loads a comment feed into `box` (once; again after an error). */
async function fill(box: HTMLElement, feedUrl: string, count?: number): Promise<void> {
    if (box.dataset.state == 'loading' || box.dataset.state == 'loaded')
        return;
    box.dataset.state = 'loading';
    box.setAttribute('aria-busy', 'true');
    box.replaceChildren(newHtml('p', {class: 'wp-comments-note'}, 'Loading comments…'));
    try {
        const comments = await loadComments(feedUrl);
        // RFC-1: if the counts promise comments that the feed doesn't have, say so instead of "No comments yet".
        box.replaceChildren(!comments.length && count
            ? newHtml('p', {class: 'wp-comments-note'}, 'The comments aren’t available right now.')
            : createCommentList(comments, feedUrl));
        box.dataset.state = 'loaded';
    } catch (e) {
        console.warn(`webpup: ${feedUrl}:`, e);
        box.replaceChildren(newHtml('p', {class: 'wp-comments-note wp-comments-error'}, 'The comments can’t be loaded.'));
        box.dataset.state = 'failed';
    }
    box.removeAttribute('aria-busy');
}

/** For the ids of the comment sections and reply lists. */
let ids = 0;

/** Opens or closes the replies to a comment: postviewer's replies button (data-action="showComments"). */
function toggleReplies(button: HTMLElement): void {
    const feedUrl = button.dataset.feedUrl;
    const comment = button.closest('.comment');
    if (!feedUrl || !comment)
        return;
    const open = button.getAttribute('aria-expanded') != 'true';
    button.setAttribute('aria-expanded', String(open));
    let box = comment.querySelector<HTMLElement>(':scope > .wp-replies');
    if (!box) {
        box = addHtml(comment, 'div', {class: 'wp-replies', id: `wp-replies-${++ids}`});
        button.setAttribute('aria-controls', box.id);
    }
    box.hidden = !open;
    const count = Number(button.dataset.count);
    if (open)
        fill(box, feedUrl, Number.isInteger(count) ? count : undefined);
}

/**
 * The comments of a post: the button for the post's actions, and the section for the card, below the actions. The
 * section is closed, unless `open`.
 */
export function postComments(feedUrl: string, count: number | undefined, open: boolean): {button: HTMLElement, section: HTMLElement} {
    const label = commentsLabel(count);
    const section = newHtml('section', {class: 'wp-comments', id: `wp-comments-${++ids}`, 'aria-label': label});
    const list = addHtml(section, 'div', {class: 'wp-comments-list'});
    const button = newHtml('button', {type: 'button', class: 'wp-post-action wp-comments-toggle', 'aria-controls': section.id},
        [icon('chat', 15), label]);
    const toggle = (show: boolean) => {
        button.setAttribute('aria-expanded', String(show));
        section.hidden = !show;
        if (show)
            fill(list, feedUrl, count);
    };
    button.addEventListener('click', () => toggle(section.hidden));
    section.addEventListener('click', e => {
        const replies = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-action="showComments"]') : null;
        if (replies && section.contains(replies))
            toggleReplies(replies);
    });
    toggle(open);
    return {button, section};
}
