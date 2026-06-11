using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace Portus.Sidecar;

/// <summary>Shared JSON settings — camelCase on the wire to match the Electron client.</summary>
internal static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}

internal sealed record Envelope(int Id, bool Ok, object? Data, string? Error);

/// <summary>
/// Newline-delimited JSON server over a named pipe (Windows) or Unix domain
/// socket (macOS/Linux). Each request is <c>{ id, cmd, data }</c>; each response
/// is <c>{ id, ok, data?, error? }</c>. Multiple connections are handled
/// concurrently; command handling itself is serialized by the store.
/// </summary>
public sealed class PipeServer(string pipePath, Func<string, JsonElement, object?> dispatch)
{
    public async Task RunAsync(CancellationToken ct)
    {
        if (OperatingSystem.IsWindows()) await RunWindowsAsync(ct);
        else await RunUnixAsync(ct);
    }

    private async Task RunWindowsAsync(CancellationToken ct)
    {
        // pipePath arrives as \\.\pipe\portus; NamedPipeServerStream wants the leaf.
        var name = pipePath.Contains('\\') ? pipePath[(pipePath.LastIndexOf('\\') + 1)..] : pipePath;
        while (!ct.IsCancellationRequested)
        {
            var server = new NamedPipeServerStream(
                name,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);
            await server.WaitForConnectionAsync(ct);
            _ = HandleConnectionAsync(server, ct);
        }
    }

    private async Task RunUnixAsync(CancellationToken ct)
    {
        if (File.Exists(pipePath)) File.Delete(pipePath);
        using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(pipePath));
        listener.Listen(16);
        while (!ct.IsCancellationRequested)
        {
            var conn = await listener.AcceptAsync(ct);
            _ = HandleConnectionAsync(new NetworkStream(conn, ownsSocket: true), ct);
        }
    }

    private async Task HandleConnectionAsync(Stream stream, CancellationToken ct)
    {
        try
        {
            using (stream)
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
            {
                string? line;
                while ((line = await reader.ReadLineAsync(ct)) is not null)
                {
                    if (line.Length == 0) continue;
                    await writer.WriteLineAsync(Process(line));
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[sidecar] connection error: {ex.Message}");
        }
    }

    private string Process(string line)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt32();
            var cmd = root.GetProperty("cmd").GetString()
                ?? throw new InvalidOperationException("missing cmd");
            var data = root.TryGetProperty("data", out var d) ? d.Clone() : default;
            var result = dispatch(cmd, data);
            return JsonSerializer.Serialize(new Envelope(id, true, result, null), Json.Options);
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new Envelope(id, false, null, ex.Message), Json.Options);
        }
    }
}
