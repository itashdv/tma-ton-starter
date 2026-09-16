import { Cell, beginCell, loadMessage, storeMessage } from '@ton/core'

/**
 * TEP-467 normalized hash of an external-in message. A wallet may serialise the same signed
 * message in different ways (source address form, import fee, body inline or in a reference),
 * so the plain BoC hash is not stable. The normalized form fixes src = addr_none, import fee 0,
 * no state init and the body in a reference.
 *
 * This is for UX only: looking up "did my transaction land" on the order page. A payment is
 * never confirmed from it, because the client controls the BoC.
 */
export function normalizedExternalMessageHash(boc: string): string {
  let cell: Cell
  try {
    cell = Cell.fromBase64(boc)
  } catch (error) {
    throw new Error(`not a base64 BoC: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  const message = loadMessage(cell.beginParse())
  if (message.info.type !== 'external-in') {
    throw new Error(`expected an external-in message, got "${message.info.type}"`)
  }
  const normalized = beginCell()
    .store(
      storeMessage(
        {
          info: { type: 'external-in', src: null, dest: message.info.dest, importFee: 0n },
          body: message.body,
        },
        { forceRef: true },
      ),
    )
    .endCell()
  return normalized.hash().toString('hex')
}
