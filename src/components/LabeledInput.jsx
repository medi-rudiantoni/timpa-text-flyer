export function LabeledInput({ label, children }) {
  return (
    <label style={{ display: "block" }}>
      <div className="mono" style={{ fontSize: 10, color: "#8A8577", marginBottom: 3, letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  );
}
