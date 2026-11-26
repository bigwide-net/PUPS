import { commentsLabel, postComments } from '../src/comments';
import { itemComments } from '../src/jsonfeed';

const O = 'https://tim.example';
const feed = (items: object[]) => JSON.stringify({version: 'https://jsonfeed.org/version/1.1', items});
const comment = (id: string, name: string, text: string, extra = {}) =>
    ({id, authors: [{name}], date_published: '2026-11-15T10:00:00Z', content_html: `<p>${text}</p>`, ...extra});

let files: Record<string, string | number> = {};
beforeEach(() => {
    files = {};
    globalThis.fetch = jest.fn(async (url: string) => {
        const f = files[url];
        return typeof f == 'string' ? {ok: true, status: 200, text: async () => f} : {ok: false, status: f ?? 404, text: async () => ''};
    }) as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

const settle = () => new Promise(r => setTimeout(r));

describe('itemComments', () => {
    it('takes the comment feed and the total, else the count', () => {
        expect(itemComments({_source: {comments: {feedUrl: '/feed/comments/3.json', count: 2, total: 5}}}, O + '/'))
            .toEqual({feedUrl: `${O}/feed/comments/3.json`, count: 5});
        expect(itemComments({_source: {comments: {feedUrl: `${O}/c.json`, count: 2}}}, O)).toEqual({feedUrl: `${O}/c.json`, count: 2});
        expect(itemComments({_source: {comments: {feedUrl: `${O}/c.json`}}}, O)).toEqual({feedUrl: `${O}/c.json`, count: undefined});
    });
    it.each([
        [{}],
        [{_source: {comments: {count: 3}}}],
        [{_source: {comments: {feedUrl: `${O}/c.json`, count: 0, total: 0}}}],
        [{_source: {comments: {feedUrl: 'javascript:alert(1)', count: 1}}}],
    ])('is undefined for %j', item => expect(itemComments(item, O)).toBeUndefined());
});

describe('postComments', () => {
    it('counts in its label', () => {
        expect(commentsLabel()).toBe('Comments');
        expect(commentsLabel(1)).toBe('1 comment');
        expect(commentsLabel(4)).toBe('4 comments');
    });

    it('loads the comments when opened, once, oldest first', async () => {
        files[`${O}/c.json`] = feed([comment('b', 'Bob', 'Second', {date_published: '2026-11-15T12:00:00Z'}), comment('a', 'Alice', 'First')]);
        const {button, section} = postComments(`${O}/c.json`, 2, false);
        expect(section.hidden).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(fetch).not.toHaveBeenCalled();
        button.click();
        await settle();
        expect(section.hidden).toBe(false);
        expect([...section.querySelectorAll('.commentAuthor')].map(e => e.textContent)).toEqual(['Alice', 'Bob']);
        button.click();
        button.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('is open at once on the post page', async () => {
        files[`${O}/c.json`] = feed([comment('a', 'Alice', 'Hi')]);
        const {button, section} = postComments(`${O}/c.json`, 1, true);
        await settle();
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(section.querySelector('.commentBody')?.textContent).toBe('Hi');
    });

    it('opens the replies to a comment from their feed', async () => {
        files[`${O}/c.json`] = feed([comment('a', 'Alice', 'Which bridge?', {_source: {comments: {feedUrl: `${O}/c/a.json`, count: 1, total: 1}}})]);
        files[`${O}/c/a.json`] = feed([comment('t', 'Tim', 'The old one.')]);
        const {section} = postComments(`${O}/c.json`, 2, true);
        await settle();
        const replies = section.querySelector<HTMLElement>('[data-action="showComments"]')!;
        expect(replies.textContent).toBe('1 reply');
        replies.click();
        await settle();
        const box = section.querySelector<HTMLElement>('.comment > .wp-replies')!;
        expect(box.querySelector('.commentAuthor')?.textContent).toBe('Tim');
        expect(replies.getAttribute('aria-controls')).toBe(box.id);
        replies.click();
        expect(box.hidden).toBe(true);
    });

    it('says when the comments fail to load, and tries again when reopened', async () => {
        files[`${O}/c.json`] = 500;
        const {button, section} = postComments(`${O}/c.json`, 2, true);
        await settle();
        expect(section.textContent).toBe('The comments can’t be loaded.');
        files[`${O}/c.json`] = feed([comment('a', 'Alice', 'Hi')]);
        button.click();
        button.click();
        await settle();
        expect(section.querySelector('.commentBody')?.textContent).toBe('Hi');
    });

    it('doesn’t claim “No comments yet” when the count promised some', async () => {
        files[`${O}/c.json`] = feed([]);
        const {section} = postComments(`${O}/c.json`, 3, true);
        await settle();
        expect(section.textContent).toBe('The comments aren’t available right now.');
    });
});
