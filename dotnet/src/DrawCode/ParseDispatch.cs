namespace DrawCode;

/// <summary>按扩展名分派，并把多语言的结果合并进同一个 IR。</summary>
internal static class ParseDispatch
{
    private static readonly string[] CsExt = [".cs"];
    private static readonly string[] CExt = [".c", ".h", ".cpp", ".hpp", ".cc", ".hh"];

    public static Model ParseAny(IReadOnlyList<string> paths, string? root = null)
    {
        root ??= Path.GetDirectoryName(Path.GetFullPath(paths[0])) ?? ".";

        var cs = paths.Where(p => HasExt(p, CsExt)).ToList();
        var c = paths.Where(p => HasExt(p, CExt)).ToList();
        var unknown = paths.Where(p => !cs.Contains(p) && !c.Contains(p)).ToList();
        if (unknown.Count > 0)
        {
            throw new InvalidOperationException("不支持的文件类型: " + string.Join(", ", unknown));
        }

        var parts = new List<Model>();
        if (c.Count > 0)
        {
            parts.Add(CParse.ParseProject(c, root));
        }

        if (cs.Count > 0)
        {
            parts.Add(CsParse.ParseCsProject(cs, root));
        }

        if (parts.Count == 1)
        {
            return parts[0];
        }

        var merged = new Model { Files = [] };
        foreach (var sub in parts)
        {
            foreach (var (k, v) in sub.Signals)
            {
                merged.Signals[k] = v;
            }

            foreach (var (k, v) in sub.Funcs)
            {
                merged.Funcs[k] = v;
            }

            foreach (var (k, v) in sub.Devices)
            {
                merged.Devices[k] = v;
            }

            merged.Files.AddRange(sub.Files);
        }

        merged.RebuildEdges();
        return merged;
    }

    private static bool HasExt(string path, string[] exts)
    {
        var lower = path.ToLowerInvariant();
        return exts.Any(e => lower.EndsWith(e, StringComparison.Ordinal));
    }
}
