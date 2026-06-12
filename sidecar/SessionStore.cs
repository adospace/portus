using Microsoft.EntityFrameworkCore;

namespace Portus.Sidecar;

/// <summary>One coordinated agent session, persisted across app restarts.</summary>
public sealed class Session
{
    public string Id { get; set; } = "";
    public string Folder { get; set; } = "";
    public string? ClaudeId { get; set; }
    /// <summary>Short title summarizing the session (from the agent CLI's terminal
    /// title). Null until one is captured; the UI falls back to the folder name.</summary>
    public string? Title { get; set; }
    public string CreatedAt { get; set; } = "";
    public string LastActive { get; set; } = "";
    public long TotalTokens { get; set; }
    public double TotalCost { get; set; }
}

public sealed class SessionDbContext(DbContextOptions<SessionDbContext> options) : DbContext(options)
{
    public DbSet<Session> Sessions => Set<Session>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Session>().HasKey(s => s.Id);
    }
}

/// <summary>
/// Thin persistence facade over EF Core + SQLite. All access is serialized
/// behind a lock because a single <see cref="SessionDbContext"/> instance is
/// shared across pipe connections and EF contexts are not thread-safe.
/// </summary>
public sealed class SessionStore : IDisposable
{
    private readonly SessionDbContext _db;
    private readonly object _gate = new();

    public SessionStore(string dbPath)
    {
        var options = new DbContextOptionsBuilder<SessionDbContext>()
            .UseSqlite($"Data Source={dbPath}")
            .Options;
        _db = new SessionDbContext(options);
        _db.Database.EnsureCreated();
        // EnsureCreated() never alters an existing schema, so a DB created before
        // the Title column existed won't have it. Add it idempotently rather than
        // pulling in EF migrations for a single nullable column.
        try
        {
            _db.Database.ExecuteSqlRaw("ALTER TABLE Sessions ADD COLUMN Title TEXT");
        }
        catch
        {
            // Column already exists (or table just created with it) — nothing to do.
        }
    }

    public Session Save(Session incoming)
    {
        lock (_gate)
        {
            var existing = _db.Sessions.Find(incoming.Id);
            if (existing is null)
            {
                _db.Sessions.Add(incoming);
            }
            else
            {
                existing.Folder = incoming.Folder;
                existing.ClaudeId = incoming.ClaudeId;
                existing.LastActive = incoming.LastActive;
                // Token/cost totals are owned by UsageTracker; don't clobber them
                // on a plain save unless the caller actually carried new totals.
                if (incoming.TotalTokens > 0) existing.TotalTokens = incoming.TotalTokens;
                if (incoming.TotalCost > 0) existing.TotalCost = incoming.TotalCost;
            }
            _db.SaveChanges();
            return _db.Sessions.Find(incoming.Id)!;
        }
    }

    public List<Session> List()
    {
        lock (_gate)
        {
            return _db.Sessions.AsNoTracking().ToList();
        }
    }

    public Session? Get(string id)
    {
        lock (_gate)
        {
            return _db.Sessions.AsNoTracking().FirstOrDefault(s => s.Id == id);
        }
    }

    public void Delete(string id)
    {
        lock (_gate)
        {
            var existing = _db.Sessions.Find(id);
            if (existing is not null)
            {
                _db.Sessions.Remove(existing);
                _db.SaveChanges();
            }
        }
    }

    /// <summary>Apply a usage delta and return the updated session.</summary>
    public Session AddUsage(string id, long tokensIn, long tokensOut, string lastActive)
    {
        lock (_gate)
        {
            var session = _db.Sessions.Find(id)
                ?? throw new InvalidOperationException($"unknown session {id}");
            var delta = tokensIn + tokensOut;
            session.TotalTokens += delta;
            session.TotalCost += UsageTracker.CostOf(tokensIn, tokensOut);
            session.LastActive = lastActive;
            _db.SaveChanges();
            return session;
        }
    }

    public void Dispose() => _db.Dispose();
}
