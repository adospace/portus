namespace Portus.Sidecar;

/// <summary>
/// Cost model for token usage. Rates are per million tokens (USD) and act as the
/// single source of truth for cost aggregation. Adjust as Claude pricing changes;
/// a future revision can load these from the app config instead of constants.
/// </summary>
public static class UsageTracker
{
    /// <summary>USD per 1M input tokens.</summary>
    public const double InputRatePerMillion = 3.0;

    /// <summary>USD per 1M output tokens.</summary>
    public const double OutputRatePerMillion = 15.0;

    public static double CostOf(long tokensIn, long tokensOut)
        => tokensIn / 1_000_000.0 * InputRatePerMillion
         + tokensOut / 1_000_000.0 * OutputRatePerMillion;
}
