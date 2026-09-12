import { useState, useCallback, useRef, useEffect, memo } from 'react';

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Button from "@mui/material/Button";

import Webcam from "react-webcam";

import { useSocket } from '../SocketContext/SocketContext.tsx';

// Kitbash assembly simulation. Override with VITE_* in .env if they run elsewhere.
const SIM_STREAM_BASE =
  (import.meta as any).env?.VITE_SIM_STREAM_URL || "http://127.0.0.1:8124";      // live-view relay (monitor.py)
const SIM_BENCH_URL =
  (import.meta as any).env?.VITE_SIM_BENCH_URL || "http://127.0.0.1:8123/index.html";  // the bench itself (serve.py)

const FRAME_INTERVAL_MS = 100;   // 10 fps, the same for the webcam and the sim

const frameStyle = {
  display: 'block',
  width: '100%',
  height: 'auto',
  borderRadius: 12,
  border: '1px solid var(--hairline)',
};


function TraineeCam( {session} ) {

  // Socket communication setup
  const socketContext = useSocket();

  useEffect(() => {
    socketContext.socket.on("connect", () => {

    });

    return () => {
      socketContext.socket.off("connect");
    };
  }, [socketContext]);


  // Stable identity: the capture effects below list this as a dependency, so
  // a fresh function on every render tore down and rebuilt the interval each
  // time the session re-rendered.
  const sendFrame = useCallback((imageSrc) => {
    const message = {
      sessionID: session.id,
      payload: {
        data: imageSrc
      }
    }

    socketContext.socket.emit('session-video-frame', message);
  }, [session.id, socketContext])


  // The capture loops below read this instead of listing sendFrame as a
  // dependency: the session page re-renders often, and rebuilding the
  // interval on every render meant its 100 ms tick never came due.
  const sendFrameRef = useRef(sendFrame);
  useEffect(() => { sendFrameRef.current = sendFrame; }, [sendFrame]);


  // Demo shortcut: ?sim=live or ?sim=edit opens straight into that sim view.
  const simParam = new URLSearchParams(window.location.search).get('sim');

  // "real" = physical webcam · "sim" = the Kitbash assembly simulation.
  // Both feed ARISTOS the same 10 fps JPEG frames on the same socket channel,
  // so nothing downstream can tell which one is running.
  const [source, setSource] = useState(simParam ? 'sim' : 'real');
  const [simAlive, setSimAlive] = useState(false);
  // How the sim is shown: 'live' = picture only · 'edit' = the interactive
  // bench embedded right here, expandable to a full-page overlay.
  const [simView, setSimView] = useState(simParam === 'edit' ? 'edit' : 'live');
  const [expanded, setExpanded] = useState(false);


  // Reference to the webcam.  Video contraints are set to use the
  // environment webcam, instead of user-facing webcam.
  const webcamRef = useRef(null);

  /**
   * This effect is used to set up an interval to capture an image from the
   * trainee's camera every XXX seconds, and send it to ARISTOS
   */
  useEffect(() => {
    if (source !== 'real') return;

    // webcamRef is a ref object and so always truthy -- the old guard here
    // checked nothing.  current is null until the camera is granted and
    // mounted, and again after unmount, where getScreenshot() would throw on
    // every tick.
    const interval = setInterval(() => {
      const imageSrc = webcamRef.current?.getScreenshot();

      if (imageSrc) {
        sendFrameRef.current(imageSrc);
      }
    }, FRAME_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [source, webcamRef]);

  /**
   * The sim equivalent: pull the latest viewport frame from the Kitbash relay
   * and send it through the same channel. This runs in every sim view mode --
   * how the sim is displayed is independent of the frames ARISTOS receives.
   */
  const simBusyRef = useRef(false);
  useEffect(() => {
    if (source !== 'sim') return;

    const interval = setInterval(async () => {
      if (simBusyRef.current) return;   // skip a tick rather than pile up
      simBusyRef.current = true;

      // A request that never settles must not wedge the loop for good.
      const abort = new AbortController();
      const abortTimer = setTimeout(() => abort.abort(), FRAME_INTERVAL_MS * 8);

      try {
        const response = await fetch(`${SIM_STREAM_BASE}/frame.jpg?t=${Date.now()}`,
          { signal: abort.signal });
        if (response.ok) {
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          sendFrameRef.current(dataUrl);
          setSimAlive(true);
        } else {
          setSimAlive(false);
        }
      } catch {
        setSimAlive(false);   // relay not running -- stay quiet, keep trying
      } finally {
        clearTimeout(abortTimer);
        simBusyRef.current = false;
      }
    }, FRAME_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [source]);

  // Escape leaves the expanded overlay.
  useEffect(() => {
    if (!expanded) return;

    const onKey = (event) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const popOut = () => {
    window.open(`${SIM_BENCH_URL}?share=1`, 'kitbash-sim',
      'width=1280,height=800,menubar=no,toolbar=no,location=no');
  };


  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="overline" sx={{ display: 'block' }}>
          Trainee view
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={source}
          onChange={(_event, value) => { if (value) setSource(value); }}
        >
          <ToggleButton value="real">Real</ToggleButton>
          <ToggleButton value="sim">Sim</ToggleButton>
        </ToggleButtonGroup>
        {source === 'sim' && (
          <>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={simView}
              onChange={(_event, value) => { if (value) setSimView(value); }}
            >
              <ToggleButton value="live">Live</ToggleButton>
              <ToggleButton value="edit">Edit</ToggleButton>
            </ToggleButtonGroup>
            <Button size="small" onClick={popOut}>Pop out ↗</Button>
          </>
        )}
      </Box>

      {source === 'real' && (
        <Webcam
          disablePictureInPicture={true}
          ref={webcamRef}
          screenshotFormat="image/jpeg"
          style={frameStyle}
        />
      )}

      {source === 'sim' && simView === 'live' && (
        <Box>
          <img
            src={`${SIM_STREAM_BASE}/stream.mjpg`}
            style={{ ...frameStyle, background: '#171b21' }}
            alt="Kitbash assembly simulation"
          />
          {!simAlive && (
            <Typography variant="caption" sx={{ color: 'var(--muted)' }}>
              Waiting for the simulation — start <code>monitor.py</code> and share
              the bench view, or switch to Edit.
            </Typography>
          )}
        </Box>
      )}

      {source === 'sim' && simView === 'edit' && (
        // The iframe is never remounted between the two sizes -- only its
        // wrapper's styling changes, so the bench keeps its assembly state.
        <Box
          sx={expanded ? {
            // the top offset keeps the toolbar clear of the page header
            position: 'fixed', inset: '72px 2vw 2vh', zIndex: 2000,
            display: 'flex', flexDirection: 'column',
            borderRadius: 3, overflow: 'hidden', boxShadow: 24,
            background: '#171b21',
          } : {
            width: '100%', height: 300,
            display: 'flex', flexDirection: 'column',
            borderRadius: 3, overflow: 'hidden',
            border: '1px solid var(--hairline)',
            background: '#171b21',
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 0.5 }}>
            <Button
              size="small"
              sx={{ minWidth: 0, color: '#8d97a5' }}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '⤡ Collapse (Esc)' : '⤢ Expand'}
            </Button>
          </Box>
          <iframe
            src={`${SIM_BENCH_URL}?share=1&embed=1`}
            title="Kitbash sim bench"
            style={{ border: 0, width: '100%', flex: 1, display: 'block' }}
            allow="fullscreen"
          />
        </Box>
      )}
    </Box>
  );

}

// Memoised: the session object handed down is now a stable reference, so
// this only re-renders when something it actually reads has changed.
export default memo(TraineeCam);
