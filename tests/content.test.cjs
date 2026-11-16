const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = readFileSync(join(__dirname, '..', 'content.js'), 'utf8');

function episode(id, title) {
    return { id, panel: { episode_metadata: { series_title: title } } };
}

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function setup(t, fetch) {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.crunchyroll.com/history'
    });
    t.after(() => dom.window.close());
    const alerts = [];
    const timers = [];
    const context = vm.createContext({
        window: dom.window,
        document: dom.window.document,
        crypto: require('node:crypto').webcrypto,
        fetch,
        console: { error() {} },
        alert: message => alerts.push(message),
        confirm: () => false,
        setInterval() {},
        setTimeout(callback, delay) {
            timers.push(delay);
            if (delay === 500) callback();
        },
        location: { reload() { throw new Error('Unexpected reload'); } }
    });
    vm.runInContext(source, context);
    return {
        context, alerts, timers, document: dom.window.document,
        run: code => vm.runInContext(code, context)
    };
}

test('series names containing quotes and HTML remain literal option values', t => {
    const app = setup(t);
    const title = 'A "Quoted" Title & <Special>';
    app.context.titles = new Set([title]);
    app.run('buildUI(); populateSelectMenu(titles)');
    const option = app.document.querySelector('#cleaner-select').options[1];
    assert.equal(option.value, title);
    assert.equal(option.textContent, title);
    assert.equal(option.children.length, 0);
});

test('collects only the selected series across every history page', async t => {
    const requested = [];
    const pages = {
        1: [episode('chosen-1', 'Chosen'), episode('other-1', 'Other')],
        2: [episode('chosen-2', 'Chosen'), episode('sequel-1', 'Chosen Season 2')],
        3: [episode('chosen-3', 'Chosen')]
    };
    const app = setup(t, async url => {
        const page = Number(new URL(url).searchParams.get('page'));
        requested.push(page);
        return response({ total: 2001, data: pages[page] });
    });
    const ids = await app.run('getEpisodeIdsByTitle("Chosen", {account_id: "test", access_token: "fake"})');
    assert.deepEqual(Array.from(ids).sort(), ['chosen-1', 'chosen-2', 'chosen-3']);
    assert.deepEqual(requested.sort(), [1, 2, 3]);
});

test('authentication uses the existing session cookie', async t => {
    let request;
    const app = setup(t, async (url, init) => {
        request = { url, ...init };
        return response({ account_id: 'test', access_token: 'fake' });
    });
    await app.run('fetchAuthToken()');
    assert.equal(request.url, 'https://www.crunchyroll.com/auth/v1/token');
    assert.equal(request.credentials, 'include');
    assert.equal(new URLSearchParams(request.body).get('grant_type'), 'etp_rt_cookie');
});

test('failed authentication provides an actionable error', async t => {
    const app = setup(t, async () => response({}, 401));
    await assert.rejects(app.run('fetchAuthToken()'), /401.*sign in/i);
});

test('a failed history request stops before deletion', async t => {
    const requests = [];
    const app = setup(t, async (url, init) => {
        requests.push(init?.method || 'GET');
        return response({ message: 'Service unavailable' }, 503);
    });
    await assert.rejects(app.run('getEpisodeIdsByTitle("Chosen", {account_id: "test", access_token: "fake"})'), /503/);
    assert.deepEqual(requests, ['GET']);
});

test('successful deletion batches preserve every selected ID', async t => {
    const requests = [];
    const app = setup(t, async (url, init) => {
        requests.push({ url, method: init.method });
        return response(null, 204);
    });
    app.context.ids = Array.from({ length: 151 }, (_, i) => `chosen-${i}`);
    await app.run('bulkDeleteEpisodes(ids, {account_id: "test", access_token: "fake"})');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.method === 'DELETE'));
    const deletedIds = requests.flatMap(request => new URL(request.url).pathname.split('/').pop().split(','));
    assert.deepEqual(deletedIds, app.context.ids);
});

test('a rejected deletion stops remaining batches', async t => {
    let count = 0;
    const app = setup(t, async () => {
        count++;
        return response({}, 429);
    });
    app.context.ids = Array.from({ length: 151 }, (_, i) => `chosen-${i}`);
    await assert.rejects(app.run('bulkDeleteEpisodes(ids, {account_id: "test", access_token: "fake"})'), /429/);
    assert.equal(count, 1);
});

test('failed deletion never displays success or schedules a reload', async t => {
    const app = setup(t, async (url, init) => {
        if (url.includes('/auth/')) return response({ account_id: 'test', access_token: 'fake' });
        if (init?.method === 'DELETE') return response({}, 403);
        return response({ total: 1, data: [episode('chosen-1', 'Chosen')] });
    });
    app.run('buildUI()');
    await app.run('executeDeepClean("Chosen", document.getElementById("cleaner-status"), document.getElementById("cleaner-btn"), document.getElementById("cleaner-select"))');
    assert.equal(app.alerts.length, 1);
    assert.match(app.alerts[0], /403/);
    assert.ok(!app.timers.includes(1500));
    assert.doesNotMatch(app.document.getElementById('cleaner-status').innerText, /Success/);
});

test('loading an expired session displays the error and keeps deletion disabled', async t => {
    const app = setup(t, async () => response({}, 401));
    app.run('buildUI()');
    await app.run('loadDatabaseSilently()');
    assert.match(app.document.getElementById('cleaner-status').textContent, /401.*sign in/i);
    assert.equal(app.document.getElementById('cleaner-btn').disabled, true);
});

test('cancelling confirmation leaves history untouched', async t => {
    let requests = 0;
    const app = setup(t, async () => { requests++; });
    app.run('buildUI(); populateSelectMenu(new Set(["Chosen"]))');
    app.document.getElementById('cleaner-select').value = 'Chosen';
    app.document.getElementById('cleaner-btn').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
    assert.equal(app.document.getElementById('cleaner-btn').disabled, false);
});
