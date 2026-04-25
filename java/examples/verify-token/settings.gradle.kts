rootProject.name = "verify-token-example"

// Pull in the sibling SDK module via a relative path so the example works
// against the in-repo source. In a real consumer you'd just declare the
// dependency on dev.realmid:sdk:0.1.0 from Maven Central.
includeBuild("../..") {
    dependencySubstitution {
        substitute(module("dev.realmid:sdk")).using(project(":"))
    }
}
