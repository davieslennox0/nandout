export function NotDeployed({ what }: { what: string }) {
  return (
    <div className="empty">
      <strong>Not deployed yet.</strong> {what} goes live when the Latch contracts are deployed on X Layer mainnet.
      Nothing on this page is simulated.
    </div>
  );
}
