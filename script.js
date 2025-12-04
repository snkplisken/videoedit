// --- CONFIGURATION ---
const PX_PER_SEC_DEFAULT = 30;
const PX_PER_SEC_MIN = 8;
const PX_PER_SEC_MAX = 120;
const TRACK_COUNT_VIDEO = 3;
const TRACK_COUNT_AUDIO = 2;

// Maps file extensions to MIME types
const VIDEO_TYPE_MAP = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    ogg: 'video/ogg',
    ogv: 'video/ogg',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    m4v: 'video/x-m4v'
};

// --- DOM ELEMENTS ---
const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false }); // Optimization: opaque canvas
const rulerCanvas = document.getElementById('rulerCanvas');
const rulerCtx = rulerCanvas.getContext('2d');
const videoPool = document.getElementById('video-pool');
const endMarker = document.getElementById('endMarker');
const btnExport = document.getElementById('btnExport');
const videoSupportProbe = document.createElement('video');
const timelineScroll = document.getElementById('timelineScroll');

// Normalize mouse/touch coordinates for mobile support
const getClientX = (e) => {
    if(e.touches && e.touches.length) return e.touches[0].clientX;
    if(e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientX;
    return e.clientX;
};

const snapTime = (time) => {
    if(!appState.snapEnabled || appState.snapGridSize <= 0) return time;
    return Math.round(time / appState.snapGridSize) * appState.snapGridSize;
};

// --- STATE ---
const appState = {
    currentTime: 0,
    projectDuration: 30,
    containerWidth: 60,
    pxPerSec: PX_PER_SEC_DEFAULT,
    userAdjustedZoom: false,
    autoZooming: false,
    skipNextAutoZoom: false,
    snapEnabled: true,
    snapGridSize: 0.5,
    resolution: { width: canvas.width, height: canvas.height },
    isPlaying: false,
    isExporting: false,
    playbackStartTime: 0, // When playback started (Audio Time)
    playbackStartOffset: 0, // Where in the timeline playback started
    selectedClip: null,
    tracks: [],
    dragging: null
};

// --- AUDIO ENGINE ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let activeAudioNodes = [];

// --- INITIALIZATION ---
function init() {
    appState.tracks = [];
    // Initialize tracks structure
    for(let i=0; i<TRACK_COUNT_VIDEO; i++) appState.tracks.push({ type: 'video', clips: [] });
    for(let i=0; i<TRACK_COUNT_AUDIO; i++) appState.tracks.push({ type: 'audio', clips: [] });

    renderTimelineTracks();
    refreshTimeline();
    initResolutionControls();
    
    // Start the render loop
    requestAnimationFrame(loop);
}

// --- FILE UPLOAD ---
const getVideoMimeType = (file) => {
    if(file.type) return file.type;
    const parts = file.name.split('.');
    const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
    return VIDEO_TYPE_MAP[ext] || '';
};

const buildVideoElement = async (file) => {
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(file);
    vid.muted = true; // Essential for allowing autoplay policies
    vid.preload = "auto";
    vid.crossOrigin = "anonymous";
    vid.playsInline = true;

    const loaded = await new Promise(res => {
        vid.onloadedmetadata = () => res(true);
        vid.onerror = () => res(false);
    });

    return loaded ? vid : null;
};

document.getElementById('inpVideo').onchange = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = null;

    for(let file of files) {
        const vid = await buildVideoElement(file);
        if(!vid) {
            console.error(`Failed to load ${file.name}`);
            continue;
        }
        videoPool.appendChild(vid);

        const clip = {
            id: 'c' + Math.random().toString(36).substr(2, 5),
            type: 'video', 
            file: file, 
            videoElement: vid,
            duration: vid.duration || 10, 
            sourceDuration: vid.duration || 10,
            start: 0, 
            offset: 0, 
            opacity: 1, 
            filter: 'none'
        };

        // Add to first available spot on Track 3 (default video track)
        const track = appState.tracks[2]; 
        const lastClip = track.clips[track.clips.length-1];
        clip.start = lastClip ? lastClip.start + lastClip.duration : 0;
        track.clips.push(clip);
    }
    refreshTimeline();
    drawPreview();
};

document.getElementById('inpAudio').onchange = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = null;
    for(let file of files) {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const clip = {
            id: 'c' + Math.random().toString(36).substr(2, 5),
            type: 'audio',
            file: file,
            buffer: audioBuffer,
            duration: audioBuffer.duration,
            sourceDuration: audioBuffer.duration,
            start: 0,
            offset: 0,
            volume: 1,
            audioEffect: 'none',
            fadeIn: 0,
            fadeOut: 0
        };
        const track = appState.tracks[3];
        const lastClip = track.clips[track.clips.length-1];
        clip.start = lastClip ? lastClip.start + lastClip.duration : 0;
        track.clips.push(clip);
    }
    refreshTimeline();
};

// --- DOM RENDERING (TIMELINE) ---
function renderTimelineTracks() {
    const container = document.getElementById('tracksContainer');
    container.innerHTML = '';
    for(let i=TRACK_COUNT_VIDEO-1; i>=0; i--) createTrackDiv(container, i, `Video ${i+1}`);
    for(let i=TRACK_COUNT_VIDEO; i<TRACK_COUNT_VIDEO+TRACK_COUNT_AUDIO; i++) createTrackDiv(container, i, `Audio ${i - TRACK_COUNT_VIDEO + 1}`);
}

function createTrackDiv(container, index, label) {
    const div = document.createElement('div');
    div.className = 'track';
    div.dataset.id = index;
    div.dataset.label = label;
    div.dataset.type = index < TRACK_COUNT_VIDEO ? 'video' : 'audio';
    container.appendChild(div);
}

function refreshTimeline() {
    if(appState.dragging && appState.dragging.action !== 'move-marker') return;

    // Calculate container width based on content
    let maxClipTime = 0;
    appState.tracks.forEach(t => t.clips.forEach(c => maxClipTime = Math.max(maxClipTime, c.start + c.duration)));

    const contentDuration = Math.max(appState.projectDuration, maxClipTime);
    if(contentDuration > appState.projectDuration) appState.projectDuration = contentDuration;

    const shouldAutoZoom = !appState.userAdjustedZoom && !appState.autoZooming && !appState.skipNextAutoZoom && !(appState.dragging && appState.dragging.action === 'move-marker');
    if(shouldAutoZoom) {
        const fitZoom = calculateFitZoom(contentDuration);
        if(Math.abs(fitZoom - appState.pxPerSec) > 0.5) {
            appState.autoZooming = true;
            setTimelineZoom(fitZoom, appState.currentTime);
            appState.autoZooming = false;
            return;
        }
    }
    if(appState.skipNextAutoZoom) appState.skipNextAutoZoom = false;

    appState.containerWidth = Math.max(maxClipTime + 10, appState.projectDuration + 10, 60);

    const wPx = appState.containerWidth * appState.pxPerSec;
    document.querySelectorAll('.track').forEach(t => t.style.width = wPx + 'px');
    updateRuler();

    endMarker.style.left = (appState.projectDuration * appState.pxPerSec) + 'px';

    if(appState.dragging && appState.dragging.action === 'move-marker') return;

    // Redraw Clips
    document.querySelectorAll('.clip').forEach(e => e.remove());
    appState.tracks.forEach((track, trackIdx) => {
        const trackDiv = document.querySelector(`.track[data-id="${trackIdx}"]`);
        track.clips.forEach(clip => {
            const el = document.createElement('div');
            el.className = `clip type-${clip.type}`;
            if(appState.selectedClip && appState.selectedClip.id === clip.id) el.classList.add('selected');
            el.style.left = (clip.start * appState.pxPerSec) + 'px';
            el.style.width = (clip.duration * appState.pxPerSec) + 'px';
            
            // HTML Structure for handles
            el.innerHTML = `
                <div class="trim-handle trim-l" data-action="trim-l"></div>
                <div class="clip-name">${clip.file.name}</div>
                <div class="trim-handle trim-r" data-action="trim-r"></div>
            `;
            
            el.onmousedown = (e) => handleClipMouseDown(e, clip, trackIdx, el);
            el.ontouchstart = (e) => handleClipMouseDown(e, clip, trackIdx, el);
            trackDiv.appendChild(el);
        });
    });

    syncRulerToScroll();
}

function setTimelineZoom(value, anchorTime = appState.currentTime) {
    const clamped = Math.min(PX_PER_SEC_MAX, Math.max(PX_PER_SEC_MIN, value));
    if(clamped === appState.pxPerSec) return;

    const centerOffset = (timelineScroll.scrollLeft + timelineScroll.clientWidth / 2) - (anchorTime * appState.pxPerSec);

    appState.pxPerSec = clamped;
    document.getElementById('timelineZoom').value = clamped;
    refreshTimeline();

    const newCenter = (anchorTime * appState.pxPerSec) + centerOffset;
    timelineScroll.scrollLeft = Math.max(0, newCenter - timelineScroll.clientWidth / 2);
}

function calculateFitZoom(durationSeconds) {
    const viewportWidth = timelineScroll ? timelineScroll.clientWidth : 0;
    const baseWidth = viewportWidth || window.innerWidth || 1200;
    const paddedDuration = Math.max(1, durationSeconds + Math.max(4, durationSeconds * 0.05));
    const target = baseWidth / paddedDuration;
    return Math.min(PX_PER_SEC_MAX, Math.max(PX_PER_SEC_MIN, target));
}

function syncRulerToScroll() {
    if(!timelineScroll) return;
    rulerCanvas.style.transform = `translateX(-${timelineScroll.scrollLeft}px)`;
}

function updateRuler() {
    const width = appState.containerWidth * appState.pxPerSec;
    if(rulerCanvas.width !== width) rulerCanvas.width = width; // Only resize if needed
    
    const rc = rulerCtx;
    rc.fillStyle = '#222'; 
    rc.fillRect(0,0,width,30);
    rc.strokeStyle = '#555'; 
    rc.fillStyle = '#888'; 
    rc.font = '10px monospace';
    
    for(let i=0; i<width; i+=appState.pxPerSec) {
        if((i/appState.pxPerSec)%5 === 0) {
            rc.beginPath(); rc.moveTo(i, 0); rc.lineTo(i, 20); rc.stroke();
            rc.fillText(formatTime(i/appState.pxPerSec), i+4, 12);
        } else {
            rc.beginPath(); rc.moveTo(i, 15); rc.lineTo(i, 25); rc.stroke();
        }
    }
}

// --- INTERACTION ---
const addDragListeners = () => {
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('touchend', onPointerUp);
};

const removeDragListeners = () => {
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('mouseup', onPointerUp);
    window.removeEventListener('touchmove', onPointerMove);
    window.removeEventListener('touchend', onPointerUp);
};

const startMarkerDrag = (e) => {
    e.stopPropagation();
    if(e.cancelable) e.preventDefault();
    const clientX = getClientX(e);
    appState.skipNextAutoZoom = true;
    appState.dragging = { action: 'move-marker', startX: clientX, originalTime: appState.projectDuration };
    addDragListeners();
};

endMarker.addEventListener('mousedown', startMarkerDrag);
endMarker.addEventListener('touchstart', startMarkerDrag, { passive: false });

function handleClipMouseDown(e, clip, trackIdx, el) {
    e.stopPropagation();
    if(e.cancelable) e.preventDefault();
    appState.selectedClip = clip;
    updatePropertiesPanel();
    document.querySelectorAll('.clip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');

    const clientX = getClientX(e);

    appState.dragging = {
        clip: clip, domElement: el,
        startTrackIdx: trackIdx, currentTrackIdx: trackIdx,
        action: e.target.dataset.action || 'move',
        startX: clientX,
        originalStart: clip.start, originalDur: clip.duration, originalOffset: clip.offset
    };
    addDragListeners();
}

function onPointerMove(e) {
    if(!appState.dragging) return;
    if(e.cancelable) e.preventDefault();
    const d = appState.dragging;
    const deltaPx = getClientX(e) - d.startX;
    const deltaSec = deltaPx / appState.pxPerSec;

    if(d.action === 'move-marker') {
        appState.projectDuration = Math.max(1, d.originalTime + deltaSec);
        refreshTimeline(); 
        return;
    }

    if(d.action === 'move') {
        let newStart = Math.max(0, d.originalStart + deltaSec);
        newStart = snapTime(newStart);
        d.domElement.style.left = (newStart * appState.pxPerSec) + 'px';
        
        // Handle track jumping
            const hoveredEl = document.elementFromPoint(getClientX(e), e.clientY || (e.touches && e.touches[0].clientY));
        const trackDiv = hoveredEl ? hoveredEl.closest('.track') : null;
        if(trackDiv) {
            const trackType = trackDiv.dataset.type;
            const trackId = parseInt(trackDiv.dataset.id);
            if(trackType === d.clip.type && trackId !== d.currentTrackIdx) {
                trackDiv.appendChild(d.domElement);
                document.querySelectorAll('.track').forEach(t => t.classList.remove('drag-over'));
                trackDiv.classList.add('drag-over');
                d.currentTrackIdx = trackId;
            }
        }
    } else if (d.action === 'trim-l') {
        const proposedStart = d.originalStart + deltaSec;
        const snappedStart = snapTime(Math.max(0, proposedStart));
        const newDur = d.originalDur + (d.originalStart - snappedStart);
        if(newDur > 0.1 && d.originalOffset + (snappedStart - d.originalStart) >= 0) {
            d.domElement.style.left = (snappedStart * appState.pxPerSec) + 'px';
            d.domElement.style.width = (newDur * appState.pxPerSec) + 'px';
        }
    } else if (d.action === 'trim-r') {
        const proposedEnd = d.originalStart + d.originalDur + deltaSec;
        const snappedEnd = snapTime(Math.max(d.originalStart, proposedEnd));
        const newDur = snappedEnd - d.originalStart;
        if(newDur > 0.1 && newDur <= (d.clip.sourceDuration - d.clip.offset)) {
            d.domElement.style.width = (newDur * appState.pxPerSec) + 'px';
        }
    }
}

function onPointerUp(e) {
    if(!appState.dragging) return;
    const d = appState.dragging;

    if(d.action !== 'move-marker') {
        const deltaPx = getClientX(e) - d.startX;
        const deltaSec = deltaPx / appState.pxPerSec;

        if(d.action === 'move') {
            d.clip.start = snapTime(Math.max(0, d.originalStart + deltaSec));
            if(d.currentTrackIdx !== d.startTrackIdx) {
                const oldTrack = appState.tracks[d.startTrackIdx];
                oldTrack.clips.splice(oldTrack.clips.indexOf(d.clip), 1);
                appState.tracks[d.currentTrackIdx].clips.push(d.clip);
            }
        } else if (d.action === 'trim-l') {
            const proposedStart = d.originalStart + deltaSec;
            const snappedStart = snapTime(Math.max(0, proposedStart));
            const newDur = d.originalDur + (d.originalStart - snappedStart);
            if(newDur > 0.1 && d.originalOffset + (snappedStart - d.originalStart) >= 0) {
                d.clip.start = snappedStart;
                d.clip.duration = newDur;
                d.clip.offset = d.originalOffset + (snappedStart - d.originalStart);
            }
        } else if (d.action === 'trim-r') {
            const proposedEnd = d.originalStart + d.originalDur + deltaSec;
            const snappedEnd = snapTime(Math.max(d.originalStart + 0.1, proposedEnd));
            const newDur = snappedEnd - d.originalStart;
            if(newDur > 0.1 && newDur <= (d.clip.sourceDuration - d.clip.offset)) {
                d.clip.duration = newDur;
            }
        }
        document.querySelectorAll('.track').forEach(t => t.classList.remove('drag-over'));
    }

    appState.dragging = null;
    removeDragListeners();
    refreshTimeline();
    drawPreview(true); // Force seek update
}

// --- PLAYBACK ENGINE ---
function loop() {
    if(appState.isPlaying) {
        // Calculate current time based on AudioContext for tighter sync
        const audioTime = audioCtx.currentTime;
        appState.currentTime = appState.playbackStartOffset + (audioTime - appState.playbackStartTime);

        // Check for End
        if(appState.currentTime >= appState.projectDuration) {
            if(appState.isExporting) {
                // Let export logic handle stop
            } else {
                pausePlayback();
                appState.currentTime = 0; // Reset to start
            }
        }
        
        // Auto-Scroll Timeline
        const scroll = document.getElementById('timelineScroll');
        const playheadPx = appState.currentTime * appState.pxPerSec;
        if(playheadPx > scroll.scrollLeft + scroll.clientWidth || playheadPx < scroll.scrollLeft) {
            scroll.scrollLeft = playheadPx - 50;
        }
    }

    // Always draw (handling pauses and seeks inside)
    drawPreview();
    requestAnimationFrame(loop);
}

// --- AUDIO LOGIC ---
function stopAudio() {
    activeAudioNodes.forEach(n => {
        try { if(n.stop) n.stop(); } catch(e){}
        try { if(n.disconnect) n.disconnect(); } catch(e){}
    });
    activeAudioNodes = [];
}

function scheduleAudioPlayback(clip, finalDest, startTime, startOffset, dur) {
    const src = audioCtx.createBufferSource();
    src.buffer = clip.buffer;

    let currentNode = src;
    const cleanupNodes = [src];

    if(clip.audioEffect === 'lowpass' || clip.audioEffect === 'highpass') {
        const filter = audioCtx.createBiquadFilter();
        filter.type = clip.audioEffect === 'lowpass' ? 'lowpass' : 'highpass';
        filter.frequency.value = clip.audioEffect === 'lowpass' ? 1200 : 500;
        currentNode.connect(filter);
        currentNode = filter;
        cleanupNodes.push(filter);
    } else if (clip.audioEffect === 'echo') {
        const delay = audioCtx.createDelay(0.5);
        delay.delayTime.value = 0.2;
        const feedback = audioCtx.createGain();
        feedback.gain.value = 0.35;
        delay.connect(feedback);
        feedback.connect(delay);
        currentNode.connect(delay);
        currentNode = delay;
        cleanupNodes.push(delay, feedback);
    }

    const gain = audioCtx.createGain();
    const baseVolume = clip.volume !== undefined ? clip.volume : 1;
    const safeDur = Math.max(0, dur);
    const fadeIn = Math.min(Math.max(0, clip.fadeIn || 0), safeDur);
    const fadeOut = Math.min(Math.max(0, clip.fadeOut || 0), safeDur);
    cleanupNodes.push(gain);

    currentNode.connect(gain);
    gain.connect(finalDest);

    const endTime = startTime + safeDur;
    if(fadeIn > 0) {
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(baseVolume, startTime + fadeIn);
    } else {
        gain.gain.setValueAtTime(baseVolume, startTime);
    }

    if(fadeOut > 0) {
        const fadeStart = Math.max(startTime, endTime - fadeOut);
        gain.gain.setValueAtTime(baseVolume, fadeStart);
        gain.gain.linearRampToValueAtTime(0, endTime);
    }

    try {
        src.start(startTime, startOffset, safeDur);
    } catch(e) { console.warn('Audio schedule error', e); }
    activeAudioNodes.push(...cleanupNodes);
}

function startPlayback(outputDestination = null) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    
    // Set sync anchor
    appState.playbackStartTime = audioCtx.currentTime;
    appState.playbackStartOffset = appState.currentTime;
    
    stopAudio();
    const finalDest = outputDestination || audioCtx.destination;

    // Schedule Audio
    for(let i=TRACK_COUNT_VIDEO; i<appState.tracks.length; i++) {
        appState.tracks[i].clips.forEach(clip => {
            const clipEnd = clip.start + clip.duration;
            
            // Only schedule if it hasn't finished yet
            if(clipEnd > appState.currentTime && clip.start < appState.projectDuration) {

                let startOffset = clip.offset;
                let startTime = appState.playbackStartTime;
                
                // Calculate relative start times
                if(clip.start > appState.currentTime) {
                    startTime += (clip.start - appState.currentTime);
                } else {
                    startOffset += (appState.currentTime - clip.start);
                }
                
                // Duration remaining
                let dur = clip.duration - (startOffset - clip.offset);
                const timeUntilProjectEnd = appState.projectDuration - Math.max(clip.start, appState.currentTime);
                dur = Math.min(dur, timeUntilProjectEnd);

                if(dur > 0) scheduleAudioPlayback(clip, finalDest, startTime, startOffset, dur);
            }
        });
    }

    appState.isPlaying = true;
    document.getElementById('playPause').innerText = "❚❚";
}

function pausePlayback() {
    appState.isPlaying = false;
    stopAudio();
    // Stop all video elements specifically
    appState.tracks.forEach(t => {
        if(t.type === 'video') t.clips.forEach(c => c.videoElement.pause());
    });
    document.getElementById('playPause').innerText = "▶";
}

// --- CONTROLS ---
document.getElementById('playPause').onclick = () => {
    if(appState.isPlaying) pausePlayback();
    else startPlayback();
};

document.getElementById('toStart').onclick = () => {
    pausePlayback();
    appState.currentTime = 0;
    drawPreview(true); // Force seek
};

const handleTimelineSeek = (e) => {
    if(e.target.id === 'endMarker') return;
    if(e.cancelable) e.preventDefault();
    if(e.target.className === 'tracks-scroll' || e.target.className === 'track') {
        const r = document.getElementById('tracksContainer').getBoundingClientRect();
        const clickedTime = Math.max(0, (getClientX(e) - r.left) / appState.pxPerSec);

        appState.currentTime = clickedTime;

        if(appState.isPlaying) {
            startPlayback(); // Resync audio
        }
        drawPreview(true); // Force seek
    }
};

timelineScroll.addEventListener('mousedown', handleTimelineSeek);
timelineScroll.addEventListener('touchstart', handleTimelineSeek, { passive: false });
timelineScroll.addEventListener('scroll', syncRulerToScroll);

// Timeline Zoom Controls
const zoomSlider = document.getElementById('timelineZoom');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomInBtn = document.getElementById('zoomIn');
zoomSlider.value = appState.pxPerSec;

zoomSlider.addEventListener('input', (e) => {
    appState.userAdjustedZoom = true;
    setTimelineZoom(parseFloat(e.target.value));
});
zoomOutBtn.addEventListener('click', () => {
    appState.userAdjustedZoom = true;
    setTimelineZoom(appState.pxPerSec - 4);
});
zoomInBtn.addEventListener('click', () => {
    appState.userAdjustedZoom = true;
    setTimelineZoom(appState.pxPerSec + 4);
});

const snapToggle = document.getElementById('snapToggle');
const snapSize = document.getElementById('snapSize');
snapToggle.checked = appState.snapEnabled;
snapSize.value = appState.snapGridSize;

snapToggle.addEventListener('change', () => {
    appState.snapEnabled = snapToggle.checked;
});

snapSize.addEventListener('input', () => {
    const val = Math.max(0.05, parseFloat(snapSize.value) || appState.snapGridSize);
    appState.snapGridSize = val;
    snapSize.value = val;
});

// --- RENDER VISUALS ---
function drawPreview(forceSeek = false) {
    // 1. Clear Canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0,0, canvas.width, canvas.height);
    
    // 2. Render Playhead & Time
    document.getElementById('playhead').style.left = (appState.currentTime * appState.pxPerSec) + 'px';
    document.getElementById('timecode').innerText = formatTime(appState.currentTime);

    // 3. Render Video Tracks
    // Sort tracks by ID (lower ID = lower layer, but usually top track covers bottom)
    // Here we iterate 0..2. Track 2 is top layer in UI? Usually higher index = top layer.
    for(let i=0; i<TRACK_COUNT_VIDEO; i++) {
        const track = appState.tracks[i];
        
        // Find clip under playhead
        const clip = track.clips.find(c => 
            appState.currentTime >= c.start && 
            appState.currentTime < c.start + c.duration
        );

        if(clip) {
            const vid = clip.videoElement;
            const targetTime = (appState.currentTime - clip.start) + clip.offset;
            
            // --- SMART SYNC LOGIC (The Anti-Choppy Fix) ---
            if(appState.isPlaying && !forceSeek) {
                // If playing, only seek if drift is bad (> 0.25s)
                if(Math.abs(vid.currentTime - targetTime) > 0.25) {
                    vid.currentTime = targetTime;
                }
                // Ensure it's moving
                if(vid.paused) vid.play().catch(()=>{}); 
            } else {
                // Paused or Scrubbing: Force exact frame
                vid.pause();
                // Avoid redundant setting to save CPU
                if(Math.abs(vid.currentTime - targetTime) > 0.05) {
                    vid.currentTime = targetTime;
                }
            }

            // Draw to canvas
            if(vid.readyState >= 2) { // HAVE_CURRENT_DATA
                ctx.save();
                ctx.globalAlpha = clip.opacity;
                
                // Filters (Optimized string concat)
                if(clip.filter !== 'none') {
                    let f = '';
                    if(clip.filter === 'bw') f = 'grayscale(100%)';
                    else if(clip.filter === '35mm') f = 'sepia(40%) contrast(1.2)';
                    else if(clip.filter === 'invert') f = 'invert(100%)';
                    else if(clip.filter === 'vhs') f = 'saturate(2) contrast(1.3) hue-rotate(-10deg)';
                    ctx.filter = f;
                }

                // Aspect Fit
                const scale = Math.min(canvas.width / vid.videoWidth, canvas.height / vid.videoHeight);
                const w = vid.videoWidth * scale;
                const h = vid.videoHeight * scale;
                const x = (canvas.width - w) / 2;
                const y = (canvas.height - h) / 2;

                ctx.drawImage(vid, x, y, w, h);
                ctx.restore();
            }
        } else {
            // Ensure unused clips are paused to save CPU
            track.clips.forEach(c => {
                if(!c.videoElement.paused) c.videoElement.pause();
            });
        }
    }
}

// --- PROJECT SETTINGS ---
function initResolutionControls() {
    const presetSelect = document.getElementById('resolutionPreset');
    const widthInput = document.getElementById('resolutionWidth');
    const heightInput = document.getElementById('resolutionHeight');
    const applyBtn = document.getElementById('applyResolution');

    const presets = {
        "480p": { width: 854, height: 480 },
        "720p": { width: 1280, height: 720 },
        "1080p": { width: 1920, height: 1080 },
        "4k": { width: 3840, height: 2160 },
        "square": { width: 1080, height: 1080 }
    };

    const setInputs = ({ width, height }) => {
        widthInput.value = Math.round(width);
        heightInput.value = Math.round(height);
    };

    presetSelect.addEventListener('change', () => {
        const chosen = presets[presetSelect.value];
        if(chosen) setInputs(chosen);
    });

    applyBtn.addEventListener('click', () => {
        const width = Math.max(320, parseInt(widthInput.value, 10) || appState.resolution.width);
        const height = Math.max(240, parseInt(heightInput.value, 10) || appState.resolution.height);
        
        appState.resolution = { width, height };
        canvas.width = width;
        canvas.height = height;
        drawPreview(true);
    });

    setInputs(appState.resolution);
}

// --- PROPERTIES ---
function updatePropertiesPanel() {
    const c = appState.selectedClip;
    if(!c) { document.getElementById('propertiesPanel').classList.add('hidden'); return; }
    document.getElementById('propertiesPanel').classList.remove('hidden');
    const isAudio = c.type === 'audio';

    document.getElementById('propVolume').value = c.volume !== undefined ? c.volume : 1;
    document.getElementById('propOpacity').value = c.opacity !== undefined ? c.opacity : 1;
    document.getElementById('propFilter').value = c.filter || 'none';
    document.getElementById('propAudioEffect').value = c.audioEffect || 'none';
    document.getElementById('propFadeIn').value = c.fadeIn !== undefined ? c.fadeIn : 0;
    document.getElementById('propFadeOut').value = c.fadeOut !== undefined ? c.fadeOut : 0;

    document.getElementById('propVideoFilterRow').classList.toggle('hidden', isAudio);
    document.getElementById('propOpacityRow').classList.toggle('hidden', isAudio);
    document.getElementById('propAudioEffectRow').classList.toggle('hidden', !isAudio);
    document.getElementById('propFadeInRow').classList.toggle('hidden', !isAudio);
    document.getElementById('propFadeOutRow').classList.toggle('hidden', !isAudio);
}
document.getElementById('propOpacity').oninput = (e) => {
    if(appState.selectedClip && appState.selectedClip.type === 'video') {
        appState.selectedClip.opacity = parseFloat(e.target.value);
        drawPreview(true);
    }
};
document.getElementById('propVolume').oninput = (e) => {
    if(appState.selectedClip) appState.selectedClip.volume = parseFloat(e.target.value);
};
document.getElementById('propFilter').onchange = (e) => {
    if(appState.selectedClip && appState.selectedClip.type === 'video') {
        appState.selectedClip.filter = e.target.value;
        drawPreview(true);
    }
};
document.getElementById('propAudioEffect').onchange = (e) => {
    if(appState.selectedClip && appState.selectedClip.type === 'audio') {
        appState.selectedClip.audioEffect = e.target.value;
    }
};
document.getElementById('propFadeIn').oninput = (e) => {
    if(appState.selectedClip && appState.selectedClip.type === 'audio') {
        appState.selectedClip.fadeIn = Math.max(0, parseFloat(e.target.value) || 0);
    }
};
document.getElementById('propFadeOut').oninput = (e) => {
    if(appState.selectedClip && appState.selectedClip.type === 'audio') {
        appState.selectedClip.fadeOut = Math.max(0, parseFloat(e.target.value) || 0);
    }
};
document.getElementById('btnDelete').onclick = () => {
    if(appState.selectedClip) {
        appState.tracks.forEach(t => {
            const i = t.clips.indexOf(appState.selectedClip);
            if(i > -1) t.clips.splice(i, 1);
        });
        appState.selectedClip = null;
        updatePropertiesPanel();
        refreshTimeline();
        drawPreview(true);
    }
};

document.getElementById('btnDuplicate').onclick = async () => {
    const source = appState.selectedClip;
    if(!source) return;

    const track = appState.tracks.find(t => t.clips.includes(source));
    if(!track) return;

    let clone = { ...source };
    clone.id = 'c' + Math.random().toString(36).substr(2, 5);
    clone.start = snapTime(source.start + source.duration + 0.1);

    if(source.type === 'video') {
        const dupVid = source.videoElement.cloneNode(true);
        dupVid.src = source.videoElement.src;
        dupVid.muted = true;
        dupVid.preload = 'auto';
        dupVid.crossOrigin = 'anonymous';
        dupVid.playsInline = true;
        videoPool.appendChild(dupVid);
        clone.videoElement = dupVid;
    }

    track.clips.push(clone);
    appState.selectedClip = clone;
    refreshTimeline();
    drawPreview(true);
    updatePropertiesPanel();
};

// --- EXPORT ---
btnExport.onclick = () => {
    if(appState.isExporting) return;

    // 1. Reset
    pausePlayback();
    appState.currentTime = 0;
    appState.isExporting = true;
    
    // 2. Codec Selection
    const types = [
        "video/webm;codecs=vp9", 
        "video/webm;codecs=vp8", 
        "video/webm",
        "video/mp4" 
    ];
    let selectedType = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    if(!selectedType) { alert("Your browser doesn't support MediaRecorder export."); return; }

    btnExport.innerText = "Rendering...";
    
    // 3. Setup Stream
    const stream = canvas.captureStream(30); // Request 30FPS stream from canvas
    const audioDest = audioCtx.createMediaStreamDestination();
    
    // Combine
    const combinedTracks = [...stream.getVideoTracks(), ...audioDest.stream.getAudioTracks()];
    const combinedStream = new MediaStream(combinedTracks);
    
    const recorder = new MediaRecorder(combinedStream, {
        mimeType: selectedType,
        videoBitsPerSecond: 5000000 // 5 Mbps
    });
    
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    
    recorder.onstop = () => {
        appState.isExporting = false;
        pausePlayback();
        btnExport.innerText = "Export Project";
        
        const blob = new Blob(chunks, { type: selectedType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `exported_video_${Date.now()}.webm`; // Extension mostly webm
        a.click();
    };
    
    // 4. Begin
    recorder.start();
    startPlayback(audioDest); // Route audio to recorder
    
    // 5. Watcher
    const checkEnd = setInterval(() => {
        if(!appState.isExporting || appState.currentTime >= appState.projectDuration) {
            recorder.stop();
            clearInterval(checkEnd);
        }
    }, 100);
};

const formatTime = t => new Date(t*1000).toISOString().substr(14, 5);

// Start
init();