namespace DrawCode.Tests;

/// <summary>
/// Shared fixtures. Golden cases under <c>tests/golden/</c> are read-only, so any test that writes
/// back to source first copies the inputs into a throwaway directory.
/// </summary>
internal static class Fixture
{
    public const string CNames = "adc.h,adc.c,dsp.h,dsp.c";
    public const string CsNames = "Adc.cs,Dsp.cs";

    public static Model SmallC() => ParseDispatch.ParseAny(
        TestPaths.Inputs("small-c", "adc.h", "adc.c", "dsp.h", "dsp.c"),
        Path.Combine(TestPaths.Case("small-c"), "input"));

    public static Model SmallCs() => ParseDispatch.ParseAny(
        TestPaths.Inputs("small-cs", "Adc.cs", "Dsp.cs"),
        Path.Combine(TestPaths.Case("small-cs"), "input"));

    /// <summary>
    /// Scratch space inside the repo. The process temp directory is not writable in this
    /// environment, and keeping throwaway copies under <c>dotnet/</c> respects the rule that
    /// nothing outside that directory is ever touched.
    /// </summary>
    public static string ScratchRoot { get; } = Path.Combine(TestPaths.RepoRoot, "dotnet", ".tmp", "tests");

    public static (string Dir, string[] Paths) CopyCase(string caseName, params string[] names)
    {
        var dir = Path.Combine(ScratchRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var paths = new List<string>();
        foreach (var n in names)
        {
            var target = Path.Combine(dir, n);
            File.Copy(TestPaths.Inputs(caseName, n)[0], target);
            paths.Add(target);
        }

        return (dir, [.. paths]);
    }

    public static string Read(string path) => Text.ReadSource(path);
}
