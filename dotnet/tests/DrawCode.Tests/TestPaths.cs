using System.Runtime.CompilerServices;

namespace DrawCode.Tests;

/// <summary>Locates the repository root so the conformance tests can read <c>tests/golden/</c>.</summary>
internal static class TestPaths
{
    public static string RepoRoot { get; } = Locate();

    public static string CasesDir => Path.Combine(RepoRoot, "tests", "golden");

    public static string XsdPath => Path.Combine(RepoRoot, "tools", "xsd", "mxfile.xsd");

    /// <summary>Resolves a case directory and fails loudly when the golden case is absent.</summary>
    public static string Case(string name)
    {
        var dir = Path.Combine(CasesDir, name);
        if (!Directory.Exists(dir))
        {
            throw new DirectoryNotFoundException("golden case directory missing: " + dir);
        }

        return dir;
    }

    public static string Golden(string caseName, string file)
    {
        var path = Path.Combine(Case(caseName), file);
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("golden file missing: " + path);
        }

        return path;
    }

    public static string[] Inputs(string caseName, params string[] names) =>
        [.. names.Select(n =>
        {
            var path = Path.Combine(Case(caseName), "input", n);
            if (!File.Exists(path))
            {
                throw new FileNotFoundException("case input missing: " + path);
            }

            return path;
        })];

    private static string Locate([CallerFilePath] string thisFile = "")
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(thisFile));
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir, "tests", "golden")))
            {
                return dir;
            }

            dir = Path.GetDirectoryName(dir);
        }

        throw new DirectoryNotFoundException(
            "could not locate the repository root (a directory containing tests/golden) above " + thisFile);
    }
}
