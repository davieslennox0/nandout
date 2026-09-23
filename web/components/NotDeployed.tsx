export function NotDeployed({ what }: { what: string }) {
  return (
    <div className="bar warn" role="status">
      <span className="dot amber" />
      <span>
        <b>Not deployed yet.</b> {what} goes live when the Latch contracts are deployed on X Layer mainnet. Nothing on this
        page is simulated.
      </span>
    </div>
  );
}
