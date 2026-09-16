import { isFinalizedValue, type ToncenterTransaction } from '../ton/toncenter.schemas'

/**
 * A transaction is final once the shard block that holds it is referenced by a masterchain
 * block: from then on it cannot be rolled back, so there is no notion of "N confirmations".
 * toncenter exposes that as `finality: 'finalized'` plus `mc_block_seqno`; `emulated` rows are
 * predictions, not observations. Every check fails closed: a missing field means "not final",
 * because a wrong `paid` cannot be undone while a late one only costs seconds.
 */
export function isFinal(
  tx: Pick<ToncenterTransaction, 'finality' | 'emulated' | 'mc_block_seqno'>,
): boolean {
  return (
    isFinalizedValue(tx.finality) &&
    tx.emulated === false &&
    typeof tx.mc_block_seqno === 'number' &&
    Number.isFinite(tx.mc_block_seqno)
  )
}
