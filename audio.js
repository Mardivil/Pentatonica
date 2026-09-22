// Plays the game's notes through Web Audio, for WebNotePlayer.
//
// Samples are fetched and decoded per instrument, the first time it is asked for, so a page load
// costs only the instrument in use. A note is scheduled on the audio clock at the moment it is due,
// which keeps a swipe's run of notes evenly spaced whatever the page is doing.
//
// A note that fails to load (no connection) is fetched again the next time it is wanted, a few
// seconds apart at most, and every instrument missing notes is tried again the moment the browser
// reports the connection back, so sound returns without reloading the page.
//
// Once the instrument in use has loaded, the others are loaded in the background one instrument at
// a time, decoded into memory so that a culture picked later sounds from its first note, and passing
// through the service worker's cache so that every culture can be heard offline. Decoding is what
// takes the time: an instrument decoded only when it is picked drops the first notes of its run as
// too late. All seven instruments decoded hold about 18 MB. A connection marked to save data skips
// this.
//
// Browsers keep audio silent until the person has touched the page: the context is resumed on the
// first pointer or key press. That press is also what swipes, and resuming takes a moment, so the
// notes of that first swipe are scheduled on the still suspended clock and play once it runs.
(function () {
    const MAX_TIER = 17;
    const LATE_MS = 300;         // how late a note that waited for its instrument may still sound
    const RETRY_MS = 3000;       // how soon a failed instrument may be fetched again
    const decoded = new Map();   // folder -> array of MAX_TIER AudioBuffers, null where not loaded
    const loading = new Set();
    const failedAt = new Map();  // folder -> time of its last failed load
    let context = null;
    let scheduled = [];          // { source, at } not yet finished
    let early = [];              // { folder, tier, rate, volume, due } asked for before loading ended
    let background = [];         // folders still to load in the background

    function audio() {
        if (context === null) {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) return null;
            context = new Context({ latencyHint: "interactive" });
        }
        return context;
    }

    // On an iPhone Web Audio follows the ring/silent switch unless the page says it plays media.
    // The game is played for its sound, so it asks to be heard like a music app.
    try {
        if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch (e) {
    }

    function unlock() {
        const c = audio();
        if (c && c.state !== "running") c.resume();
    }
    for (const type of ["pointerdown", "keydown", "touchend"]) {
        window.addEventListener(type, unlock, { capture: true, passive: true });
    }

    window.addEventListener("online", () => {
        failedAt.clear();
        for (const [folder, buffers] of decoded) {
            if (!complete(buffers)) load(folder);
        }
        runBackground();
    });

    function url(folder, tier) {
        return "notes/" + folder + "/" + String(tier).padStart(2, "0") + ".wav";
    }

    function complete(buffers) {
        return buffers !== undefined && buffers.every(buffer => buffer !== null);
    }

    function load(folder) {
        if (loading.has(folder) || complete(decoded.get(folder))) return;
        if (Date.now() - (failedAt.get(folder) || 0) < RETRY_MS) return;
        const c = audio();
        if (!c) return;
        loading.add(folder);
        const buffers = decoded.get(folder) || new Array(MAX_TIER).fill(null);
        const notes = [];
        buffers.forEach((buffer, index) => {
            if (buffer !== null) return;
            notes.push(fetch(url(folder, index + 1))
                .then(response => {
                    if (!response.ok) throw new Error(response.status);
                    return response.arrayBuffer();
                })
                .then(bytes => c.decodeAudioData(bytes))
                .then(decodedNote => { buffers[index] = decodedNote; })
                .catch(() => {}));
        });
        Promise.all(notes).then(() => {
            decoded.set(folder, buffers);
            loading.delete(folder);
            if (complete(buffers)) {
                failedAt.delete(folder);
                runBackground();
            } else {
                failedAt.set(folder, Date.now());
            }
            // Notes asked for while the instrument was loading, such as the run a culture plays
            // the moment it is picked, play now if they are not already too late to belong.
            const waiting = early.filter(note => note.folder === folder);
            early = early.filter(note => note.folder !== folder);
            const now = performance.now();
            for (const note of waiting) {
                const remaining = note.due - now;
                if (remaining > -LATE_MS) play(folder, note.tier, note.rate, note.volume, Math.max(0, remaining));
            }
        });
    }

    function play(folder, tier, rate, volume, delayMs) {
        const c = audio();
        if (!c || c.state === "closed") return;
        const buffers = decoded.get(folder);
        const buffer = buffers ? buffers[Math.min(Math.max(tier, 1), MAX_TIER) - 1] : null;
        if (!buffer) {
            if (!loading.has(folder) && Date.now() - (failedAt.get(folder) || 0) < RETRY_MS) return;
            early.push({ folder, tier, rate, volume, due: performance.now() + Math.max(0, delayMs) });
            load(folder);
            return;
        }
        const source = c.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        const gain = c.createGain();
        gain.gain.value = volume;
        source.connect(gain);
        gain.connect(c.destination);
        const at = c.currentTime + Math.max(0, delayMs) / 1000;
        source.start(at);
        const entry = { source, at };
        scheduled.push(entry);
        source.onended = () => {
            scheduled = scheduled.filter(item => item !== entry);
        };
    }

    // Stops notes that are scheduled but have not started. Notes already sounding ring out.
    function cancelPending() {
        early = [];
        if (context === null) return;
        const now = context.currentTime;
        scheduled = scheduled.filter(item => {
            if (item.at <= now) return true;
            try {
                item.source.stop();
            } catch (e) {
            }
            return false;
        });
    }

    // Queues every instrument for the background load, which starts once the instrument in use has
    // loaded (runBackground is called from there) and stops at the first failure, to go on when the
    // connection comes back.
    function prefetch(folders) {
        const connection = navigator.connection;
        if (connection && connection.saveData) return;
        background = folders.split(",");
    }

    // Loads the queued instruments one after another through load(), so the background never
    // competes with more than one instrument's worth of decoding. load() calls back here when an
    // instrument completes, which moves the queue on.
    function runBackground() {
        while (background.length > 0 && complete(decoded.get(background[0]))) background.shift();
        if (background.length === 0 || loading.size > 0) return;
        const folder = background[0];
        if (Date.now() - (failedAt.get(folder) || 0) < RETRY_MS) return;
        load(folder);
    }

    window.pentatonicaAudio = { load, play, cancelPending, prefetch };
})();
