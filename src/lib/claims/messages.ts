// Claim notices that can outlive the state they describe. They are worded in
// past tense so they stay true after the job is claimed or completed by someone
// else; the order row and the assignment dialog show the current state.

export function claimExpiredNotice(orderTitle: string): string {
  return `Your previous claim on “${orderTitle}” expired before verification.`;
}
