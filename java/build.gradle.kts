plugins {
    `java-library`
    `maven-publish`
}

group = "dev.realmid"
version = "0.11.0"

base {
    archivesName.set("sdk")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
    withJavadocJar()
    withSourcesJar()
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

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "sdk"
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
                scm {
                    url.set("https://github.com/Realm-ID/sdk")
                    connection.set("scm:git:git://github.com/Realm-ID/sdk.git")
                    developerConnection.set("scm:git:ssh://github.com:Realm-ID/sdk.git")
                }
            }
        }
    }
}
