rootProject.name = "realmid-sdk-server-example"

includeBuild("../..") {
    dependencySubstitution {
        substitute(module("dev.realmid:sdk")).using(project(":"))
    }
}
