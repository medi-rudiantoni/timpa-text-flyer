import { useQuery } from "@tanstack/react-query";
import { fetchDownloadLogs, INK, LINE, TEAL, TEAL_DARK } from "../lib/templateUtils";

export function HistoryPage() {
  const { data: logs = [], isLoading: loading, isError: loadError, refetch: loadLogs } = useQuery({
    queryKey: ["download_logs"],
    queryFn: fetchDownloadLogs,
  });

  const formatTime = (iso) => {
    try {
      return new Date(iso).toLocaleString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  if (loading) {
    return <div className="p-8 mono" style={{ fontSize: 13, color: "#8A8577" }}>Memuat riwayat…</div>;
  }

  if (loadError) {
    return (
      <div className="p-8">
        <p style={{ fontSize: 13, color: "#B0432E", marginBottom: 8 }}>Gagal memuat riwayat download.</p>
        <button onClick={loadLogs} className="mono" style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, background: TEAL, color: "#F7F5EF" }}>
          Coba lagi
        </button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: "#6B7280" }}>
          RIWAYAT DOWNLOAD ({logs.length})
        </div>
        <button onClick={loadLogs} className="mono" style={{ fontSize: 11, color: TEAL_DARK }}>
          ↻ Refresh
        </button>
      </div>

      {logs.length === 0 ? (
        <p style={{ fontSize: 13, color: "#8A8577" }}>Belum ada yang download hasil apa pun.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {logs.map((log) => (
            <div key={log.id} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, background: "#FCFBF7" }}>
              <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{log.template_name}</div>
                <div className="flex items-center gap-2">
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: TEAL,
                      color: "#F7F5EF",
                    }}
                  >
                    {(log.format || "").toUpperCase()}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "#8A8577" }}>
                    {formatTime(log.downloaded_at)}
                  </span>
                </div>
              </div>
              {log.field_values && Object.keys(log.field_values).length > 0 && (
                <div className="flex flex-col gap-1" style={{ marginTop: 8, borderTop: `1px solid ${LINE}`, paddingTop: 8 }}>
                  {Object.entries(log.field_values).map(([label, value]) => (
                    <div key={label} className="flex" style={{ fontSize: 12, gap: 6 }}>
                      <span className="mono" style={{ color: "#8A8577", minWidth: 90 }}>{label}</span>
                      <span style={{ color: INK }}>{value || <em style={{ color: "#B5AF9C" }}>(kosong)</em>}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
