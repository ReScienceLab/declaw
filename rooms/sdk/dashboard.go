package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"golang.org/x/net/websocket"
)

// DashboardServer serves the WebSocket + static files dashboard.
type DashboardServer struct {
	port       int
	staticDir  string
	server     *http.Server
	clients    sync.Map // *websocket.Conn → struct{}
	getState   func() any
	roomServer *Server // back-reference for admin API
}

func newDashboard(port int, staticDir string) *DashboardServer {
	return &DashboardServer{port: port, staticDir: staticDir}
}

// SetStateFunc registers a function that returns the full state
// snapshot sent to new WebSocket connections.
func (d *DashboardServer) SetStateFunc(fn func() any) {
	d.getState = fn
}

// Start begins serving HTTP + WebSocket on the configured port.
func (d *DashboardServer) Start() error {
	mux := http.NewServeMux()

	// WebSocket endpoint
	mux.Handle("/ws", websocket.Handler(d.handleWS))

	// Admin API endpoints
	mux.HandleFunc("/api/lobby", d.handleAPILobby)
	mux.HandleFunc("/api/start", d.handleAPIStart)
	mux.HandleFunc("/api/reset", d.handleAPIReset)
	mux.HandleFunc("/api/invites", d.handleAPIInvites)
	mux.HandleFunc("/api/kick", d.handleAPIKick)

	// Static files
	mux.Handle("/", http.FileServer(http.Dir(d.staticDir)))

	d.server = &http.Server{
		Addr:    fmt.Sprintf("[::]:%d", d.port),
		Handler: mux,
	}
	go func() {
		if err := d.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[dashboard] server error: %v", err)
		}
	}()
	log.Printf("[dashboard] Listening on [::]::%d  static=%s", d.port, d.staticDir)
	return nil
}

// Stop shuts down the HTTP server gracefully.
func (d *DashboardServer) Stop(ctx context.Context) error {
	if d.server != nil {
		return d.server.Shutdown(ctx)
	}
	return nil
}

// Broadcast sends a JSON event to all connected WebSocket clients.
func (d *DashboardServer) Broadcast(event any) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	d.clients.Range(func(k, _ any) bool {
		conn := k.(*websocket.Conn)
		if err := websocket.Message.Send(conn, string(data)); err != nil {
			d.clients.Delete(k)
		}
		return true
	})
}

func (d *DashboardServer) handleWS(conn *websocket.Conn) {
	d.clients.Store(conn, struct{}{})
	defer d.clients.Delete(conn)

	// Send initial state
	if d.getState != nil {
		initial := map[string]any{"event": "state", "data": d.getState()}
		if data, err := json.Marshal(initial); err == nil {
			_ = websocket.Message.Send(conn, string(data))
		}
	}

	// Keep connection alive until client disconnects
	var msg string
	for {
		if err := websocket.Message.Receive(conn, &msg); err != nil {
			break
		}
	}
}

// ── Admin API handlers ────────────────────────────────────────────────────────

func (d *DashboardServer) jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (d *DashboardServer) handleAPILobby(w http.ResponseWriter, r *http.Request) {
	if d.roomServer == nil {
		d.jsonReply(w, 500, map[string]string{"error": "not initialized"})
		return
	}
	d.jsonReply(w, 200, d.roomServer.adminLobbyState())
}

func (d *DashboardServer) handleAPIStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		d.jsonReply(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if d.roomServer == nil {
		d.jsonReply(w, 500, map[string]string{"error": "not initialized"})
		return
	}
	if err := d.roomServer.AdminStartGame(); err != nil {
		d.jsonReply(w, 409, map[string]string{"error": err.Error()})
		return
	}
	d.jsonReply(w, 200, map[string]string{"status": "started"})
}

func (d *DashboardServer) handleAPIReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		d.jsonReply(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if d.roomServer == nil {
		d.jsonReply(w, 500, map[string]string{"error": "not initialized"})
		return
	}
	d.roomServer.AdminResetRoom()
	go d.roomServer.runLobby(r.Context())
	d.jsonReply(w, 200, map[string]string{"status": "reset"})
}

func (d *DashboardServer) handleAPIInvites(w http.ResponseWriter, r *http.Request) {
	if d.roomServer == nil {
		d.jsonReply(w, 500, map[string]string{"error": "not initialized"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		d.jsonReply(w, 200, d.roomServer.InviteGetAll())
	case http.MethodPost:
		var body struct {
			Addr  string `json:"addr"`
			Label string `json:"label"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Addr == "" {
			d.jsonReply(w, 400, map[string]string{"error": "need addr"})
			return
		}
		d.roomServer.InviteAdd(body.Addr, body.Label)
		d.roomServer.BroadcastWS(map[string]any{
			"event": "lobby",
			"data":  d.roomServer.adminLobbyState(),
		})
		d.jsonReply(w, 200, map[string]string{"status": "added"})
	case http.MethodDelete:
		addr := r.URL.Query().Get("addr")
		if addr == "" {
			d.jsonReply(w, 400, map[string]string{"error": "need addr query param"})
			return
		}
		d.roomServer.InviteRemove(addr)
		d.roomServer.BroadcastWS(map[string]any{
			"event": "lobby",
			"data":  d.roomServer.adminLobbyState(),
		})
		d.jsonReply(w, 200, map[string]string{"status": "removed"})
	default:
		d.jsonReply(w, 405, map[string]string{"error": "GET/POST/DELETE only"})
	}
}

func (d *DashboardServer) handleAPIKick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		d.jsonReply(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if d.roomServer == nil {
		d.jsonReply(w, 500, map[string]string{"error": "not initialized"})
		return
	}
	var body struct {
		Seat string `json:"seat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Seat == "" {
		d.jsonReply(w, 400, map[string]string{"error": "need seat"})
		return
	}
	d.roomServer.KickSeat(body.Seat)
	d.jsonReply(w, 200, map[string]string{"status": "kicked"})
}
