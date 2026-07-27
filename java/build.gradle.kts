import com.vanniktech.maven.publish.SonatypeHost

plugins {
    `java-library`
    // Publishes signed artifacts to Maven Central via the Central Portal
    // (OSSRH was sunset 2025). Applies `maven-publish` + `signing` itself and
    // adds the sources/javadoc jars, so we don't configure those by hand.
    id("com.vanniktech.maven.publish") version "0.30.0"
}

group = "dev.realmid"
version = "0.29.1"

base {
    archivesName.set("sdk")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

repositories {
    mavenCentral()
}

dependencies {
    api("com.fasterxml.jackson.core:jackson-databind:2.17.2")
    compileOnly("jakarta.servlet:jakarta.servlet-api:6.0.0")

    testImplementation(platform("org.junit:junit-bom:5.11.0"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("jakarta.servlet:jakarta.servlet-api:6.0.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    // JDK HttpClient + com.sun.net.httpserver keep-alive interop is flaky
    // under test. Disable connection reuse so each test request gets a
    // fresh socket; production configurations should keep the default.
    systemProperty("jdk.httpclient.keepalive.timeout", "0")
    testLogging {
        events("passed", "skipped", "failed")
    }
}

mavenPublishing {
    // Target the Central Portal. The workflow invokes
    // `publishAndReleaseToMavenCentral`, which uploads and releases in one
    // step (no manual "publish" click in the portal UI).
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL)
    // GPG-sign every artifact — a hard Central Portal requirement. Keys are
    // provided in-memory via ORG_GRADLE_PROJECT_signingInMemoryKey* in CI.
    signAllPublications()

    coordinates(group.toString(), "sdk", version.toString())

    pom {
        name.set("Realm ID SDK")
        description.set("Partner SDK for verifying RealmID-issued JWTs")
        url.set("https://realmid.dev")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/licenses/MIT")
            }
        }
        developers {
            developer {
                id.set("realmid")
                name.set("RealmID")
                email.set("engineering@realmid.dev")
                organization.set("RealmID")
                organizationUrl.set("https://realmid.dev")
            }
        }
        scm {
            url.set("https://github.com/Realm-ID/sdk")
            connection.set("scm:git:git://github.com/Realm-ID/sdk.git")
            developerConnection.set("scm:git:ssh://github.com:Realm-ID/sdk.git")
        }
    }
}
