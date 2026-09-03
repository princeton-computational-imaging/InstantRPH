// Synchronized video playback: one shared engine, two presentations.
//
// createVideoSyncGroup() holds any number of <video> elements on the same
// frame. Two things are built on it:
//
//   initVideoComparison()   the hero slider -- two videos under a wipe divider
//   initLaeTrainingGallery() the LAE galleries -- a grid or row of clips
//
// Which roots share a group is keyed by the value of
// [data-lae-training-gallery]: roots carrying the same non-empty value are
// driven as one group, a root with the bare attribute is a group of its own.
// The reparameterization grid and the hologram row below it are both frames of
// one training run -- same length, same frame rate -- so they share the key
// "lae-training" and stay on the same iteration. The parallax row is a
// different section at a different length and frame rate, so it does not.
//
// == How a group is held together ==
//
// videos[0] is the master; the rest are followers pulled toward it. Every state
// change goes through the shared pauseAll()/playAll() pair, so no video is ever
// started or stopped on its own.
//
// The videos must not carry the `loop` attribute. Native looping wraps each
// video on its own clock, so the group ends up a whole cycle apart at the seam;
// looping is driven from here instead, as one restart of the group.
//
// Holding a group together takes three mechanisms, because there are three
// distinct ways it can come apart:
//
//   1. Resuming. play() on several elements does not mean all start moving: one
//      whose data is not buffered stalls while the others run on. playAll()
//      waits until every video can actually play before starting any of them.
//      That wait is capped, because it cannot be a precondition for loading:
//      iOS fetches nothing from `preload` alone, so a gate that holds play()
//      until `canplay` is waiting on the one thing only playing would produce.
//   2. Stalling mid-play. A video that runs out of buffered data freezes while
//      its partners keep going. `waiting` is therefore a state change for the
//      group: stop all, then resume all together.
//   3. Slow drift. Absent either of the above, decoders still creep apart.
//      monitorSync() samples the gap every animation frame and closes it -- by
//      trimming a follower's playback rate while the gap is small (imperceptible,
//      and no seek), by a full stop-align-resume once it is too large to walk
//      back invisibly.
//
// Correcting drift by assigning currentTime every frame is what this replaces,
// and it does not work: currentTime is only ever *approximately* equal between
// two decoders, so a tolerance tighter than the correction itself re-seeks the
// follower on every animation frame and the element never finishes seeking --
// it renders as frozen. Below SYNC_HARD_LIMIT nothing here seeks at all.
//
// Seeks are asynchronous, so anything that realigns a group waits for `seeked`
// before resuming; resuming mid-seek would let the settled video start while
// another was still moving, reopening the gap just closed.
//
// Tunable parameters can be set per-instance as data-attributes on the outer
// element, or left out to fall back to the defaults below:
//
//   .video-comparison
//     data-start-position   initial divider position, 0-100 (% from left)   default: 50
//     data-sweep-speed      auto-sweep velocity, in % of width per second   default: 12
//     data-edge-pause       pause at each end before reversing, in ms       default: 700
//
//   [data-lae-training-gallery]
//     the attribute's own value   group key: roots sharing a non-empty value
//                           play as one group          default: its own group
//     data-frame-rate       fps of the clips, so the drift thresholds can be
//                           scaled to one frame                  default: 25

const VIDEO_COMPARISON_DEFAULTS = {
    startPosition: 50,
    sweepSpeed: 192,
    edgePause: 700,
};

// HTMLMediaElement.HAVE_FUTURE_DATA: enough data to advance from the current
// position, i.e. play() will actually start moving rather than stall.
const HAVE_FUTURE_DATA = 3;

// Drift handling, in seconds of playback time. These are floors: a group backed
// by low-frame-rate clips scales them up from its frame duration, because two
// videos sitting on the same frame are already as aligned as they can get.
const SYNC_TOLERANCE = 0.02;    // ~half a frame at 25fps: already matched, leave it alone
const SYNC_HARD_LIMIT = 0.25;   // beyond this a rate trim would take too long: stop and realign
const SYNC_CONVERGE = 1.5;      // seconds a rate trim is given to close the gap
const SYNC_MAX_TRIM = 0.08;     // cap on that trim, so the correction stays invisible
const SEEK_TIMEOUT = 500;       // ms before a silent seek is assumed done, so nothing strands paused
const READY_TIMEOUT = 1500;     // ms before a group starts without every video reporting canplay

// Frame-duration multipliers for the two drift thresholds. Below one frame
// there is nothing to correct; a few frames apart is past what a rate trim can
// walk back in reasonable time.
const TOLERANCE_FRAMES = 0.75;
const HARD_LIMIT_FRAMES = 3;

// Keep a group running slightly before it scrolls into view, so it is already
// buffered and moving by the time it is on screen.
const VISIBILITY_MARGIN = '200px 0px';

// Resume a group only once its root is on screen (or about to be), and
// suspend it again once it isn't. This is what keeps an unseen video group
// from ever downloading -- shared by every gallery and the hero comparison,
// so a group is never fetched before the reader can actually see it.
//
// Takes one root or several, because a group can span more than one root (the
// LAE grid and the hologram row below it). With several, visibility is the
// union: the group runs while *any* of its roots is on screen. Tracking which
// ones are is what makes that union work -- reacting to each entry on its own
// would let the row scrolling out suspend a group whose grid is still in view.
function observeVisibility(roots, group) {
    const targets = Array.isArray(roots) ? roots : [roots];
    if (typeof IntersectionObserver === 'undefined') {
        group.resume();
        return;
    }
    const onScreen = new Set();
    const observer = new IntersectionObserver((observed) => {
        observed.forEach((entry) => {
            if (entry.isIntersecting) onScreen.add(entry.target);
            else onScreen.delete(entry.target);
        });
        if (onScreen.size > 0) group.resume();
        else group.suspend();
    }, { rootMargin: VISIBILITY_MARGIN });
    targets.forEach((target) => observer.observe(target));
}

// Drive a set of videos as a single unit. Returns the handles callers need;
// everything else -- looping, stall recovery, drift correction -- is internal.
//
// options.frameRate  fps of the clips, used to scale the drift thresholds
// options.onFrame    per-frame callback, for whatever the caller draws
// options.suspended  start suspended (nothing loads or plays until resume())
function createVideoSyncGroup(videos, options = {}) {
    const master = videos[0];
    const followers = videos.slice(1);
    const onFrame = options.onFrame || null;

    const frameDuration = options.frameRate > 0 ? 1 / options.frameRate : 0;
    const tolerance = Math.max(SYNC_TOLERANCE, frameDuration * TOLERANCE_FRAMES);
    const hardLimit = Math.max(SYNC_HARD_LIMIT, frameDuration * HARD_LIMIT_FRAMES);

    // Enforced here, not just in the markup: a stray `loop` attribute would
    // silently reintroduce per-video wrapping. muted and playsInline are the
    // two conditions iOS puts on autoplay -- every tile carries them as
    // attributes already, but one added without them would fail silently, with
    // play() rejecting and nothing on screen to say why.
    videos.forEach((v) => {
        v.loop = false;
        v.muted = true;
        v.playsInline = true;
    });

    // Bumped on every transition so a resume still waiting on buffers or on a
    // seek can tell it has been superseded (e.g. the pointer came back) and
    // abort instead of restarting a group someone else has since taken over.
    let transition = 0;
    let restarting = false;
    let held = false;                          // the caller is driving the group (hover scrub)
    let suspended = Boolean(options.suspended); // off screen: paused, not animating
    let rafId = null;

    // Seeking a video that has nothing loaded is pointless -- it sits at 0
    // already -- and unsafe: older WebKit answers a currentTime write on a
    // HAVE_NOTHING element with an InvalidStateError, which would throw out of
    // resume() and strand the whole group. resume() calls load(), so that state
    // is reachable on every first paint, not just in theory.
    function seekTo(video, time) {
        if (video.readyState === 0) return;
        try {
            video.currentTime = time;
        } catch (err) {
            // Not seekable yet; the next resync() picks it up once it is.
        }
    }

    // The two shared state transitions. Nothing else touches play/pause.

    function pauseAll() {
        transition += 1;
        videos.forEach((v) => v.pause());
        followers.forEach((v) => { v.playbackRate = 1; });
        // Everything is frozen now, so this lands on one matching frame.
        followers.forEach((v) => seekTo(v, master.currentTime));
    }

    function playAll() {
        const token = ++transition;

        // Deliberately no seek here. Callers align the group first and then
        // wait for that seek to land, so by this point every video is already
        // on the same frame and nothing has advanced.
        const start = () => {
            if (token !== transition) return;
            videos.forEach((v) => v.play().catch(() => {}));
        };

        // play() returning does not mean a video is advancing: one whose data
        // is not buffered yet stalls while the others run on, so they resume a
        // fraction of a second apart. Only start once every video can actually
        // play, so all begin moving on the same tick.
        const stalled = videos.filter((v) => v.readyState < HAVE_FUTURE_DATA);
        if (stalled.length === 0) {
            start();
            return;
        }
        // That readiness gate is an optimisation, though, never a precondition
        // for loading: iOS downloads nothing until play() is called, so a group
        // still waiting to be fetched would sit here forever, gated on a
        // `canplay` only playing could produce. Start anyway once the timeout
        // is up -- a ragged start is self-healing, since monitorSync() and the
        // `waiting` -> resync() path exist to close exactly that gap, and
        // start()'s token check keeps a stale timer from reviving a group that
        // has since been suspended or held.
        let pending = stalled.length;
        const fallback = setTimeout(start, READY_TIMEOUT);
        stalled.forEach((v) => {
            v.addEventListener('canplay', () => {
                pending -= 1;
                if (pending > 0) return;
                clearTimeout(fallback);
                start();
            }, { once: true });
        });
    }

    // Run `done` once no video is mid-seek. Setting currentTime only *starts* a
    // seek, so this is what makes an alignment safe to resume from.
    function waitForSeek(done) {
        const seeking = videos.filter((v) => v.seeking);
        if (seeking.length === 0) {
            done();
            return;
        }
        let remaining = seeking.length;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            done();
        };
        seeking.forEach((v) => v.addEventListener('seeked', () => {
            remaining -= 1;
            if (remaining === 0) finish();
        }, { once: true }));
        // A seek superseded by a later one never reports back under its own
        // listener; without this the group would stay paused forever.
        setTimeout(finish, SEEK_TIMEOUT);
    }

    // Stop the group, put it back on one frame, and start it again together.
    // The general recovery: used on every resume, and whenever the gap grows
    // past what a playback-rate trim can absorb.
    function resync() {
        pauseAll();
        const token = transition;
        waitForSeek(() => {
            if (token !== transition || held || suspended) return;
            playAll();
        });
    }

    // Looping, done once for the group rather than N times on N clocks.
    function restartAll() {
        if (restarting) return;
        restarting = true;
        transition += 1;
        const token = transition;
        videos.forEach((v) => {
            v.pause();
            seekTo(v, 0);
        });
        followers.forEach((v) => { v.playbackRate = 1; });
        waitForSeek(() => {
            restarting = false;
            if (token !== transition || held || suspended) return;
            playAll();
        });
    }

    // Close whatever gap has opened since the last animation frame.
    function monitorSync() {
        if (held || suspended || restarting) return;
        if (videos.some((v) => v.paused || v.seeking)) return;

        const worst = followers.reduce(
            (max, v) => Math.max(max, Math.abs(v.currentTime - master.currentTime)),
            0,
        );
        if (worst > hardLimit) {
            resync();
            return;
        }

        followers.forEach((v) => {
            const drift = v.currentTime - master.currentTime;
            if (Math.abs(drift) <= tolerance) {
                v.playbackRate = 1;
                return;
            }
            // A follower ahead (drift > 0) runs slower, behind runs faster.
            // Trimming the rate closes the gap without a seek, so nothing
            // visibly jumps.
            const trim = Math.max(-SYNC_MAX_TRIM, Math.min(SYNC_MAX_TRIM, -drift / SYNC_CONVERGE));
            v.playbackRate = 1 + trim;
        });
    }

    function tick(timestamp) {
        rafId = null;
        if (suspended) return;
        monitorSync();
        if (onFrame) onFrame(timestamp);
        rafId = requestAnimationFrame(tick);
    }

    function startLoop() {
        if (rafId === null) rafId = requestAnimationFrame(tick);
    }

    function stopLoop() {
        if (rafId === null) return;
        cancelAnimationFrame(rafId);
        rafId = null;
    }

    videos.forEach((v) => {
        // A stall is one video freezing while the others keep playing, so it
        // has to be handled as a transition of the group, not of one element.
        v.addEventListener('waiting', () => {
            if (held || suspended || restarting) return;
            if (videos.every((other) => other.paused)) return;
            resync();
        });
        v.addEventListener('ended', restartAll);
    });

    // rAF stops while the tab is hidden, so monitorSync() is not running, but
    // the videos may keep decoding -- or be paused by the browser. Either way
    // the group can come back in any state.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || held || suspended) return;
        resync();
    });

    let readyCount = 0;
    function onReady() {
        readyCount += 1;
        if (readyCount < videos.length) return;
        if (suspended) return;
        resync();
        startLoop();
    }
    videos.forEach((v) => {
        if (v.readyState >= 2) onReady();
        else v.addEventListener('loadeddata', onReady, { once: true });
    });

    return {
        // The caller is scrubbing/hovering: freeze the group on one frame and
        // leave it there until released, then realign and resume.
        setHold(value) {
            if (held === value) return;
            held = value;
            if (held) pauseAll();
            else if (!suspended) resync();
        },

        // Off screen. Nothing plays and no frames are drawn, so an unseen
        // gallery costs neither bandwidth nor CPU.
        suspend() {
            if (suspended) return;
            suspended = true;
            stopLoop();
            pauseAll();
        },

        // Back on screen. Raising preload and re-running the load is what
        // actually pulls the media down; playAll()'s readiness gate then starts
        // everything together once it has arrived.
        resume() {
            if (!suspended) return;
            suspended = false;
            // preload is only a hint, and only for the *next* resource
            // selection: a video that already ran one and stopped at
            // HAVE_METADATA stays there on iOS however the attribute is set
            // afterwards -- which is what used to leave the LAE and parallax
            // tiles black on iPhone. load() re-runs the selection with the new
            // value. Skipped once a video is genuinely playable, so a gallery
            // scrolled back into view is not restarted from zero.
            videos.forEach((v) => {
                v.preload = 'auto';
                if (v.readyState < HAVE_FUTURE_DATA) v.load();
            });
            if (held) return;
            resync();
            startLoop();
        },
    };
}

function initVideoComparison(root) {
    const stage = root.querySelector('.video-comparison-stage');
    const base = root.querySelector('.video-comparison-base');
    const overlay = root.querySelector('.video-comparison-overlay');
    const divider = root.querySelector('.video-comparison-divider');
    const progressFill = root.querySelector('.video-comparison-progress-fill');
    if (!stage || !base || !overlay || !divider) return;

    const config = {
        startPosition: parseFloat(root.dataset.startPosition) || VIDEO_COMPARISON_DEFAULTS.startPosition,
        sweepSpeed: parseFloat(root.dataset.sweepSpeed) || VIDEO_COMPARISON_DEFAULTS.sweepSpeed,
        edgePause: parseFloat(root.dataset.edgePause) || VIDEO_COMPARISON_DEFAULTS.edgePause,
    };

    let position = config.startPosition;
    let direction = 1;
    let hovering = false;
    let edgeWaiting = false;
    let lastTimestamp = null;

    function setPosition(pct) {
        position = Math.min(100, Math.max(0, pct));
        overlay.style.clipPath = `inset(0 ${100 - position}% 0 0)`;
        divider.style.left = `${position}%`;
    }

    function updateProgress() {
        if (!progressFill) return;
        const duration = base.duration;
        const progress = Number.isFinite(duration) && duration > 0
            ? Math.min(1, Math.max(0, base.currentTime / duration))
            : 0;
        progressFill.style.width = `${progress * 100}%`;
    }

    function positionFromEvent(e) {
        const rect = stage.getBoundingClientRect();
        return ((e.clientX - rect.left) / rect.width) * 100;
    }

    // The sweep keeps running while hovering -- the divider follows the
    // pointer -- so this is driven every frame regardless of the hold.
    function onFrame(timestamp) {
        updateProgress();
        if (hovering) {
            lastTimestamp = null;
            return;
        }
        if (lastTimestamp === null) lastTimestamp = timestamp;
        const dt = (timestamp - lastTimestamp) / 1000;
        lastTimestamp = timestamp;

        if (edgeWaiting) return;
        setPosition(position + direction * config.sweepSpeed * dt);
        if (position >= 100 || position <= 0) {
            edgeWaiting = true;
            setTimeout(() => {
                direction *= -1;
                edgeWaiting = false;
            }, config.edgePause);
        }
    }

    // The hero pair runs to well over a hundred megabytes combined. Loading it
    // eagerly on DOMContentLoaded is what used to make the whole page feel
    // stuck: everything else -- the 3D method figure's textures included --
    // queued behind it. Start suspended and let visibility pull it in instead,
    // same as every other gallery on the page.
    const group = createVideoSyncGroup([base, overlay], { onFrame, suspended: true });
    observeVisibility(root, group);

    stage.addEventListener('mouseenter', (e) => {
        hovering = true;
        group.setHold(true);
        setPosition(positionFromEvent(e));
    });

    stage.addEventListener('mousemove', (e) => {
        if (hovering) setPosition(positionFromEvent(e));
    });

    stage.addEventListener('mouseleave', () => {
        hovering = false;
        group.setHold(false);
    });

    setPosition(position);
}

// `roots` is every root sharing this group's key -- usually one, but the LAE
// grid and the hologram row come in together so their tiles land in a single
// group and stay on one training iteration.
function initLaeTrainingGallery(roots) {
    // Videos and their playbars are paired per tile rather than collected into
    // two independent lists: a tile with a video but no playbar would otherwise
    // shift the indices and drive the wrong tile's bar.
    const tiles = roots.flatMap((root) => Array.from(root.querySelectorAll('.lae-training-tile')));
    const entries = tiles
        .map((tile) => ({
            tile,
            video: tile.querySelector('.lae-training-video'),
            bar: tile.querySelector('.lae-playbar-fill'),
        }))
        .filter((entry) => entry.video);
    if (entries.length === 0) return;

    const videos = entries.map((entry) => entry.video);

    function updateBars() {
        entries.forEach(({ video, bar }) => {
            if (!bar) return;
            const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
            const progress = duration > 0 ? Math.min(1, Math.max(0, video.currentTime / duration)) : 0;
            bar.style.width = `${progress * 100}%`;
        });
    }

    // One frame rate for the group: the roots of a shared key hold clips from
    // the same render, so the first declared value speaks for all of them.
    const declared = roots.map((root) => parseFloat(root.dataset.frameRate)).find((rate) => rate > 0);

    const group = createVideoSyncGroup(videos, {
        frameRate: declared || 0,
        onFrame: updateBars,
        suspended: true,
    });

    videos.forEach((video) => {
        video.addEventListener('loadedmetadata', updateBars, { once: true });
    });

    // These clips run to hundreds of megabytes, and fetching them all at once
    // starves the buffers of whichever gallery the reader is actually looking
    // at -- which is what a stall, and then a desync, is made of. Each gallery
    // loads and plays only around the time it is on screen. A group spanning
    // several roots does pull all of them in as soon as one comes into view,
    // which is the price of starting them together.
    observeVisibility(roots, group);

    entries.forEach(({ tile }) => {
        if (tile.classList.contains('lae-psnr-overlay') || tile.hasAttribute('data-no-zoom')) return;

        function updateZoomPosition(event) {
            const rect = tile.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * 100;
            const y = ((event.clientY - rect.top) / rect.height) * 100;
            tile.style.setProperty('--zoom-x', `${Math.min(100, Math.max(0, x))}%`);
            tile.style.setProperty('--zoom-y', `${Math.min(100, Math.max(0, y))}%`);
        }

        tile.addEventListener('mouseenter', (event) => {
            tile.classList.add('is-zoomed');
            updateZoomPosition(event);
        });

        tile.addEventListener('mousemove', updateZoomPosition);

        tile.addEventListener('mouseleave', () => {
            tile.classList.remove('is-zoomed');
            tile.style.setProperty('--zoom-x', '50%');
            tile.style.setProperty('--zoom-y', '50%');
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.video-comparison').forEach(initVideoComparison);

    // Bucket the gallery roots by their attribute value before initialising
    // any of them, so roots sharing a key are handed over as one group. An
    // empty value is not a key -- those roots each stand alone, which is why
    // the buckets are keyed by object identity in that case.
    const buckets = new Map();
    document.querySelectorAll('[data-lae-training-gallery]').forEach((root) => {
        const key = root.dataset.laeTrainingGallery || root;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(root);
        else buckets.set(key, [root]);
    });
    buckets.forEach(initLaeTrainingGallery);
});
