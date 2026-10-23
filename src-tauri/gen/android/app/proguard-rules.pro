# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# youtubedl-android разбирает JSON через Jackson (рефлексия) и грузит классы по
# имени — R8 не должен их вырезать или переименовывать в релизной сборке.
-keep class com.yausername.** { *; }
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**
-dontwarn java.beans.**
# commons-compress (распаковка Python) и commons-io.
-keep class org.apache.commons.** { *; }
-dontwarn org.apache.commons.**
# Плагин Mestia: Tauri находит его и аргументы команд (@InvokeArg) по рефлексии.
-keep class com.mestia.app.** { *; }
