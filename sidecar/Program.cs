using System.Text.Json;
using Portus.Sidecar;

// Args from the Electron host: [dbPath, pipePath]. Fall back to sensible local
// defaults so the sidecar can also be run by hand for debugging.
var dbPath = args.Length > 0 ? args[0] : "portus.db";
var pipePath = args.Length > 1
    ? args[1]
    : OperatingSystem.IsWindows() ? @"\\.\pipe\portus" : "/tmp/portus.sock";

using var store = new SessionStore(dbPath);

object? Dispatch(string cmd, JsonElement data)
{
    switch (cmd)
    {
        case "session.save":
            return store.Save(data.Deserialize<Session>(Json.Options)
                ?? throw new InvalidOperationException("invalid session payload"));

        case "session.list":
            return store.List();

        case "session.get":
            return store.Get(data.GetProperty("id").GetString()!);

        case "session.delete":
            store.Delete(data.GetProperty("id").GetString()!);
            return null;

        case "usage.add":
            var sessionId = data.GetProperty("sessionId").GetString()!;
            var tokensIn = data.GetProperty("tokensIn").GetInt64();
            var tokensOut = data.GetProperty("tokensOut").GetInt64();
            return store.AddUsage(sessionId, tokensIn, tokensOut, DateTime.UtcNow.ToString("o"));

        default:
            throw new InvalidOperationException($"unknown command: {cmd}");
    }
}

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

var server = new PipeServer(pipePath, Dispatch);
Console.Error.WriteLine($"[sidecar] listening on {pipePath}, db={dbPath}");

try
{
    await server.RunAsync(cts.Token);
}
catch (OperationCanceledException)
{
    // graceful shutdown
}
