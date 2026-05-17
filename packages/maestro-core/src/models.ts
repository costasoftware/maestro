/**
 * Two-tier model router for chat surfaces. Picks between a fast/cheap
 * model and a smart/expensive one based on cheap heuristics on the
 * user's last message.
 *
 * The kernel ships sensible defaults tuned for an owner-help persona
 * (lookups → fast; mutations/long asks → smart). Hosts override the
 * model ids by passing `models` and can extend or replace the keyword
 * triggers via the optional `smartKeywords` / threshold args.
 *
 * The kernel does NOT read `process.env` — host products are responsible
 * for pulling `MODEL_ID` overrides from their own env layer and passing
 * them in. Keeps the kernel testable in isolation and avoids the
 * surprise of NEXT_PUBLIC-style build-time inlining.
 */

export type ModelTier = 'fast' | 'smart'

export interface ModelSelection {
    tier: ModelTier
    modelId: string
    /** Short string describing why this tier was chosen. Useful for telemetry. */
    reason: string
}

/**
 * Default trigger words mapped to mutation verbs or compositional asks
 * that justify routing to the smart tier. Tuned for Portuguese /
 * Spanish / English owner-help personas. Replace via `smartKeywords`
 * when the persona shifts.
 */
export const DEFAULT_SMART_KEYWORDS: readonly string[] = [
    // PT
    'agendar',
    'agenda pra',
    'marcar',
    'cancelar',
    'remarcar',
    'registrar venda',
    'registra venda',
    'vendi',
    'criar promoç',
    'criar cupom',
    'cadastrar cliente',
    'mesclar',
    'excluir',
    'apagar',
    'comparar',
    'compare',
    'resumo geral',
    'me dá um resumo',
    'agendamento em série',
    'série de agendamentos',
    // ES
    'reservar',
    'reagendar',
    'registrar venta',
    'crear promo',
    'crear cupon',
    'eliminar',
    'resumen general',
    // EN
    'book ',
    'schedule ',
    'cancel',
    'reschedule',
    'log a sale',
    'record sale',
    'create coupon',
    'create promotion',
    'merge clients',
    'delete',
    'summary',
]

/** Default message-length threshold (chars) above which we route smart. */
export const DEFAULT_SMART_LENGTH_THRESHOLD = 200

/** Default user-turn count above which we route smart (deeper chains benefit from reasoning). */
export const DEFAULT_SMART_TURN_THRESHOLD = 4

export interface SelectModelArgs {
    /** Most recent user message. */
    userMessage: string
    /** 1-based user-turn count for the thread. */
    turnIndex?: number
    /** Caller may force the tier (e.g. a known-complex nudge). */
    forceTier?: ModelTier

    /**
     * Model ids per tier. The kernel does not read env; the host
     * resolves overrides from its env layer and passes them here.
     *
     * `force` short-circuits to that exact model id regardless of
     * tier — useful for canary rollouts and eval pinning.
     */
    models: {
        fast: string
        smart: string
        force?: string | null
    }

    /** Override the default keyword trigger set. Pass `[]` to disable keyword routing entirely. */
    smartKeywords?: readonly string[]
    /** Override the default length threshold (chars). */
    smartLengthThreshold?: number
    /** Override the default turn-depth threshold. */
    smartTurnThreshold?: number
}

/**
 * Heuristic router. Smart tier wins when any of:
 *   - `forceTier === 'smart'` (caller intent)
 *   - message length ≥ length threshold
 *   - turn index ≥ turn threshold
 *   - message contains a keyword trigger
 * Otherwise fast. `models.force` always wins when set.
 */
export function selectChatModel(args: SelectModelArgs): ModelSelection {
    const forceId = args.models.force ?? null
    if (forceId) {
        return { tier: 'fast', modelId: forceId, reason: 'force-override' }
    }
    if (args.forceTier === 'smart') {
        return { tier: 'smart', modelId: args.models.smart, reason: 'forced' }
    }
    if (args.forceTier === 'fast') {
        return { tier: 'fast', modelId: args.models.fast, reason: 'forced' }
    }

    const text = (args.userMessage ?? '').trim().toLowerCase()
    if (text.length === 0) {
        return { tier: 'fast', modelId: args.models.fast, reason: 'empty' }
    }

    const lengthThreshold = args.smartLengthThreshold ?? DEFAULT_SMART_LENGTH_THRESHOLD
    if (text.length >= lengthThreshold) {
        return { tier: 'smart', modelId: args.models.smart, reason: 'long-message' }
    }

    const turn = args.turnIndex ?? 1
    const turnThreshold = args.smartTurnThreshold ?? DEFAULT_SMART_TURN_THRESHOLD
    if (turn >= turnThreshold) {
        return { tier: 'smart', modelId: args.models.smart, reason: 'deep-thread' }
    }

    const keywords = args.smartKeywords ?? DEFAULT_SMART_KEYWORDS
    for (const keyword of keywords) {
        if (text.includes(keyword)) {
            return {
                tier: 'smart',
                modelId: args.models.smart,
                reason: `keyword:${keyword.trim()}`,
            }
        }
    }

    return { tier: 'fast', modelId: args.models.fast, reason: 'default-fast' }
}
