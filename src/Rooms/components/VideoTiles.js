// VideoTiles.jsx (replace existing file)
import React, { useEffect, useRef, useState, useCallback } from "react";
import Peer from "simple-peer";
import ACTIONS from "../Actions";
import Draggable from 'react-draggable'
import { ResizableBox } from "react-resizable";
import "react-resizable/css/styles.css";

const VideoTiles = ({ socketRef, roomId, enableMedia = false, clients=[]}) => {
  const [streams, setStreams] = useState({});
  const peersRef = useRef({});
  const localStreamRef = useRef(null);
  const localReadyRef = useRef(false);
  const pendingAllUsers = useRef([]);
  const pendingJoined = useRef([]);
  const pendingSignals = useRef([]);
  const [localId, setLocalId] = useState(null);

  const addStream = (id, stream) =>
    setStreams((prev) => (prev[id] === stream ? prev : { ...prev, [id]: stream }));

  const removeStream = (id) =>
    setStreams((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
        const getInitials = (username) => {
        if (!username) return "NA";
        const parts = username.split(" ");
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
      };


  const cleanupPeer = (remoteId) => {
    const p = peersRef.current[remoteId];
    if (p) {
      try { p.destroy(); } catch (e) {}
      delete peersRef.current[remoteId];
    }
    removeStream(remoteId);
    console.log("[VideoTiles] cleaned peer:", remoteId);
  };

  const normalizeId = (incoming) => (typeof incoming === "string" ? incoming : incoming?.socketId);

  const createPeer = (remoteId, initiator) => {
    if (!remoteId) return;
    if (peersRef.current[remoteId]) return peersRef.current[remoteId];

    const peer = new Peer({
      initiator,
      trickle: false,
      stream: localStreamRef.current || undefined,
    });

    peer.on("signal", (signal) => {
      try { socketRef.current.emit("signal", { to: remoteId, signal }); }
      catch (e) { console.warn("[VideoTiles] emit signal failed", e); }
    });

    peer.on("stream", (remoteStream) => {
      addStream(remoteId, remoteStream);
    });

    peer.on("close", () => cleanupPeer(remoteId));
    peer.on("error", (err) => console.warn("[VideoTiles] peer error", remoteId, err));

    peersRef.current[remoteId] = peer;
    return peer;
  };

  const flushPendingSignals = (sock) => {
    if (!pendingSignals.current.length) return;
    pendingSignals.current.forEach(({ from, signal }) => {
      if (from === sock.id) return;
      if (!peersRef.current[from]) {
        addStream(from, null);
        createPeer(from, false);
      }
      try { peersRef.current[from].signal(signal); } catch (err) { console.warn(err); }
    });
    pendingSignals.current = [];
  };

  // start local media (callable)
  const startLocal = useCallback(async () => {
    const sock = socketRef?.current;
    if (!sock) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      localReadyRef.current = true;
      setLocalId(sock.id);
      addStream(sock.id, stream);

      // process any pending entries
      if (pendingAllUsers.current.length) {
        pendingAllUsers.current.forEach((id) => {
          if (id === sock.id) return;
          addStream(id, null);
          if (!peersRef.current[id]) createPeer(id, true);
        });
        pendingAllUsers.current = [];
      }
      if (pendingJoined.current.length) {
        pendingJoined.current.forEach((id) => {
          if (id === sock.id) return;
          addStream(id, null);
          if (!peersRef.current[id]) createPeer(id, false);
        });
        pendingJoined.current = [];
      }

      flushPendingSignals(sock);
      sock.emit('media-ready', { roomId });
      console.log("[VideoTiles] local media started & media-ready emitted");
    } catch (err) {
      console.warn("[VideoTiles] getUserMedia failed:", err);
      // still mark local ready so peers can be created, but no tracks
      localReadyRef.current = true;
      setLocalId(sock.id);
      addStream(sock.id, null);
      sock.emit('media-ready', { roomId });
      flushPendingSignals(sock);
    }
  }, [roomId, socketRef]);

  // stop local media (callable)
  const stopLocal = useCallback(() => {
    const sock = socketRef?.current;
    if (localStreamRef.current) {
      try {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      localStreamRef.current = null;
    }
    localReadyRef.current = false;
    setLocalId(null);
    removeStream(sock?.id);
    try { sock?.emit('media-stopped', { roomId }); } catch (e) {}
    console.log("[VideoTiles] local media stopped");
  }, [roomId, socketRef]);

  // effect: handle socket events & peer orchestration (unchanged logic, minus auto startLocal)
  useEffect(() => {
    if (!socketRef?.current) return;
    const sock = socketRef.current;
    let mounted = true;

    const handleAllUsers = ({ users = [] }) => {
      const ids = users.map(normalizeId);
      if (!localReadyRef.current) {
        pendingAllUsers.current.push(...ids.filter((id) => id !== sock.id));
        return;
      }
      ids.forEach((id) => {
        if (id === sock.id) return;
        addStream(id, null);
        if (!peersRef.current[id]) createPeer(id, true);
      });
    };


    const handleUserJoined = ({ socketId }) => {
      const id = normalizeId(socketId) || socketId;
      if (!localReadyRef.current) {
        pendingJoined.current.push(id);
        return;
      }
      if (!peersRef.current[id]) {
        addStream(id, null);
        createPeer(id, false);
      }
    };

    const handleSignal = ({ from, signal }) => {
      const fromId = normalizeId(from) || from;
      if (!fromId || fromId === sock.id) return;
      if (!localReadyRef.current) {
        pendingSignals.current.push({ from: fromId, signal });
        return;
      }
      if (!peersRef.current[fromId]) {
        addStream(fromId, null);
        createPeer(fromId, false);
      }
      try { peersRef.current[fromId].signal(signal); } catch (err) { console.warn(err); }
    };

    const handleUserLeft = ({ socketId }) => cleanupPeer(normalizeId(socketId) || socketId);

    const handleUserMediaReady = ({ socketId: remoteId }) => {
      const id = normalizeId(remoteId) || remoteId;
      if (!id || id === sock.id) return;
      if (!localReadyRef.current) {
        pendingJoined.current.push(id);
        return;
      }
      if (!peersRef.current[id]) {
        addStream(id, null);
        createPeer(id, false);
      }
    };

    sock.on("all-users", handleAllUsers);
    sock.on("user-joined", handleUserJoined);
    sock.on("signal", handleSignal);
    sock.on("user-left", handleUserLeft);
    sock.on("user-media-ready", handleUserMediaReady);
    sock.on(ACTIONS.JOINED, ({ clients = [], socketId: joinedSocketId }) => {
      const clientIds = clients.map(normalizeId).filter(Boolean);
      clientIds.forEach((id) => { if (id === sock.id) return; if (!streams[id]) addStream(id, null); });
      // if this join event is for me, start peers to others:
      if (joinedSocketId === sock.id) {
        clientIds.forEach((id) => { if (id === sock.id) return; if (!peersRef.current[id]) createPeer(id, true); });
      } else {
        const newId = normalizeId(joinedSocketId) || joinedSocketId;
        if (newId && newId !== sock.id && !peersRef.current[newId]) {
          addStream(newId, null);
          createPeer(newId, false);
        }
      }
    });

    return () => {
      mounted = false;
      sock.off("all-users", handleAllUsers);
      sock.off("user-joined", handleUserJoined);
      sock.off("signal", handleSignal);
      sock.off("user-left", handleUserLeft);
      sock.off("user-media-ready", handleUserMediaReady);
      sock.off(ACTIONS.JOINED);

      Object.values(peersRef.current).forEach((p) => { try { p.destroy(); } catch (e) {} });
      peersRef.current = {};
      if (localStreamRef.current) {
        try { localStreamRef.current.getTracks().forEach((t) => t.stop()); } catch (e) {}
        localStreamRef.current = null;
      }
      setStreams({});
      localReadyRef.current = false;
      pendingAllUsers.current = [];
      pendingJoined.current = [];
      pendingSignals.current = [];
    };
  }, [roomId, socketRef]); // runs once when socketRef or roomId changes

  // effect: start / stop media when enableMedia prop changes
  useEffect(() => {
    if (enableMedia) startLocal();
    else stopLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableMedia]); // startLocal/stopLocal are stable due to useCallback deps

  return (
    <div
      style={{
        flex: "0 0 160px",
        display: "flex",
        alignItems: "stretch",
        gap: 12,
        overflowX: "auto",
        overflowY: "hidden",
        padding: "10px 12px",
        borderBottom: "2px solid #333",
        minWidth: 0,
        flexWrap: "nowrap",
      }}
      className="videoRibbon"
    >
      {Object.entries(streams).map(([id, stream]) => (
        <div key={id} style={{ flex: "0 0 auto" }}>
          <Draggable axis="x" bounds="parent">
            <div style={{ display: "inline-block" }}>
              <ResizableBox width={220} height={140} minConstraints={[160, 100]} maxConstraints={[420, 300]} resizeHandles={["se"]}>
                {stream ? (
                  <video
                    ref={(el) => { if (el && stream) el.srcObject = stream; }}
                    autoPlay
                    playsInline
                    muted={id === localId}
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8, background: "#000" }}
                  />
                ) : (
                  <div style={{ width: "100%", height: "100%", borderRadius: 8, background: "linear-gradient(135deg,#46319C )", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 24, fontWeight: 700 }}>
                    {getInitials(clients.find(c => c.socketId === id)?.username)}
                  </div>
                )}
              </ResizableBox>
            </div>
          </Draggable>
        </div>
      ))}
    </div>
  );
};

export default VideoTiles;
